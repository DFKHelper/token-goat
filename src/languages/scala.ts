/** Scala symbol extractor — regex-based (no tree-sitter grammar needed). Extracts: classes, objects, traits, case classes, Scala 3 enums, functions (def), fields (val/var), and `import` directives. */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripBlockCommentSpan,
  stripLineComment,
  stripMultilineStringSpan,
  stripStringLiterals,
  type AdapterImport,
  type MultilineStringState,
  type StripStringOpts,
  makeLineSymbol,
} from './common.js'

/** Scala spells a character literal `'a'`, but a `'` that opens none is a symbol literal or a Scala 3 quoted block and never closes. Every read of a Scala line -- blanking its strings and finding its `//` -- has to apply that same rule, or the two disagree about where the line's code ends. */
const SCALA_STRIP: StripStringOpts = { symbolLiterals: true, interpolatorPrefix: true }

interface TypeFrame {
  name: string
  startDepth: number
  bodyEntered: boolean
  // Net unclosed `(` count accumulated since the frame was pushed, counted on string-blanked text. A declaration whose parameter list spans several lines (`class Multi(` / `val a: Int,` / `) {`) is still mid-declaration until this returns to 0, so the stale-frame sweep below must not treat it as finished just because no brace has arrived yet.
  openParens: number
  // Column the declaration itself starts at, and whether it opened a Scala 3 indentation-syntax body (`object Foo:` with no `{`). Such a frame has no closing brace to pop it, so its extent is governed by indentation: it ends at the first non-blank line indented no further than `declIndent`.
  declIndent: number
  colonBody: boolean
  // Column of the first line of an indentation-syntax body, which is the column its direct members sit at. Null until that line is seen.
  bodyIndent: number | null
  // Index in `symbols` of the type this frame opened, so its one-line span can be widened to the indentation body when the frame is popped.
  symbolIndex: number
  // The `end` marker that closes this frame's indentation body when it is not `end <name>`: an anonymous given closes with `end given`.
  endMarker?: string
}

// Declaration kinds whose `=`-terminated head hands the body to the lines below it.
const MEMBER_KINDS: ReadonlySet<string> = new Set(['function', 'val', 'var'])

/** The symbol widened to run through `endLine`, with its body re-sliced from the source lines. */
function withSpanEnd(sym: SymbolEntry, endLine: number, lines: readonly string[]): SymbolEntry {
  if (endLine <= sym.lineStart) return sym
  return { ...sym, lineEnd: endLine, body: lines.slice(sym.lineStart - 1, endLine).join('\n') }
}

/** Last line of the run of lines after `startLine` (1-based) that sit deeper than `declIndent`, which is where an `=`-terminated definition's body ends when it has no braces. Blank and comment-only lines neither end the run nor extend it, so trailing ones are left out of the span. */
function indentedBodyEnd(lines: readonly string[], startLine: number, declIndent: number): number {
  let end = startLine
  for (let j = startLine; j < lines.length; j++) {
    const text = lines[j] ?? ''
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.startsWith('//')) continue
    if (indentOf(text) <= declIndent) break
    end = j + 1
  }
  return end
}

// Leading-whitespace width of an already comment-stripped line, counting a tab as one column (Scala 3's own indentation rules treat tabs as opaque and the language reference discourages mixing them, so no tab-expansion table is warranted here).
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

// `import scala.util.matching.Regex` or `import java.util._` (wildcard imports)
const IMPORT_RE = /^import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\._)?)/

// `import foo.bar.{A, B, C}` -- Scala's idiomatic multi-selector import. IMPORT_RE alone can't express this: its character class stops at `{`, so it captures only the truncated, non-actionable prefix `foo.bar.` and silently drops every selector actually being imported.
const BRACE_IMPORT_RE = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)\.\{([^}]*)\}/

// The modifier prefix shared by every declaration pattern below. The group is `(?:...\s+)*` (zero or MORE, not the old `?` zero-or-one) because real Scala routinely stacks several modifiers before the keyword -- `sealed abstract class Shape` (the idiomatic Scala ADT base-class pattern) and `final case class Foo(...)` (an extremely common case-class form) both carry two modifiers. With the old `?` cap, matching one modifier left the following keyword expected immediately after it; the second modifier word sat where `class`/`object`/`trait`/`def`/`val`/`var` was expected, so the WHOLE line failed to match and the declaration -- plus, for a type, every symbol nested in its body -- was silently dropped from the index entirely. Two further widenings, each of which loses the whole declaration (and, for a type header, every symbol in its body) when it is missing. First, `private` and `protected` may carry a qualifier in square brackets naming the scope the declaration stays visible within: `private[this] val cached`, `private[pkg] class Hidden`, `protected[pkg] def helper`. Second, Scala 3 added the soft modifiers `open` (a class explicitly declared extensible), `inline`, `transparent` (as in `transparent inline def`) and `infix`. All four are soft keywords, so they are also legal identifiers: that is safe here only because MODS is always immediately followed by one of the reserved words `class`/`object`/`trait`/`enum`/`def`/`val`/`var`, which cannot begin anything but a definition, so a word sitting directly before one of them is a modifier by construction. A `val open = true` or a `def infix(x: Int)` still resolves to the right name, because MODS is `*` and the engine backtracks to the split that satisfies the keyword.
const MODS = '(?:(?:implicit|lazy|sealed|abstract|final|(?:private|protected)(?:\\[[A-Za-z_][A-Za-z0-9_]*\\])?|override|covariant|contravariant|case|open|inline|transparent|infix)\\s+)*'

// Scala lets any declaration be named with a backtick-quoted identifier holding characters a bare identifier cannot (spaces, punctuation, reserved words), and the ScalaTest/munit convention of writing test and helper names as prose makes that spelling routine in real sources. Every pattern below admitted only the bare identifier class, so a backtick-quoted class, object, trait, def, val or var produced no symbol at all -- and for a quoted type header no frame was pushed either, so every member declared inside its body was dropped too. Widen by ALTERNATIVE: the quoted form carries its own backtick delimiters, so it cannot run past the declaration boundary. Adding a backtick and a space to the bare identifier class instead would let a name bleed into the following `extends`/`with`/self-type clause and capture trailing whitespace.
const NAME = '(?:`[^`\\r\\n]+`|[A-Za-z_][A-Za-z0-9_]*)'

// Strip the backtick delimiters so the stored name is the identifier Scala code actually refers to (mirrors kotlin.ts's unquoteName).
function unquoteName(name: string): string {
  return name.length >= 2 && name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name
}

// `class Foo`, `class Foo[T]`, `class Foo(x: Int)`, `class Foo extends Base`. Also matches `case class Foo`.
const CLASS_RE = new RegExp('^\\s*' + MODS + 'class\\s+(' + NAME + ')(?:\\s|\\[|\\(|:|$)')

// `object Singleton`, `object Foo extends Base`, and Scala's `package object util`. A package object spells the `package` keyword in front of `object`, and `package` is not one of the modifiers above, so the line matched nothing: the package object itself and every member of its body went unindexed.
const OBJECT_RE = new RegExp('^\\s*(?:package\\s+)?' + MODS + 'object\\s+(' + NAME + ')(?:\\s|:|$)')

// `trait Viewable`, `trait Comparable[T]`
const TRAIT_RE = new RegExp('^\\s*' + MODS + 'trait\\s+(' + NAME + ')(?:\\s|\\[|:|$)')

// Scala 3 (2021) `enum` type declaration: `enum Color`, `enum Option[+T]`, `enum Color(val rgb: Int)`. A brand-new type keyword absent from CLASS_RE/OBJECT_RE/ TRAIT_RE (none of which contains the literal `enum`), so an `enum Color { ... }` block AND every `def` nested in its body were dropped from the index entirely -- the same missing-type-keyword gap class already closed for Swift `actor` and Dart `mixin class`. The only legal leading modifiers on an enum are access modifiers (`private`/`protected`).
const ENUM_RE = new RegExp('^\\s*(?:private|protected)?\\s*enum\\s+(' + NAME + ')(?:\\s|\\[|\\(|:|$)')

// A Scala method name has three spellings a bare identifier cannot express, each added as its own ALTERNATIVE: backtick-quoted prose, a pure operator, and the alphanumeric-then-operator form Scala reserves behind a trailing underscore (`def unary_-` for a prefix operator, `def value_=` for a setter). `:` belongs in the operator class because it is a Scala operator character and the cons-style `:::`, `::` and `+:` operators are core collection API; the operator alternative can only fire when the name's first character is an operator character, so `def foo: Int` still captures `foo` via the bare-identifier alternative.
const DEF_NAME = '(?:`[^`\\r\\n]+`|[A-Za-z_][A-Za-z0-9_]*_[+\\-*/%=!<>&|^~:]+|[+\\-*/%=!<>&|^~:]+|[A-Za-z_][A-Za-z0-9_]*)'

// Scala function/method: `def foo()`, `def bar[T]()`, `def baz: Int` (no-arg form), infix operators like `def +(other: Int)`. Generics come between name and params.
const FUNC_RE = new RegExp('^\\s*' + MODS + 'def\\s+(' + DEF_NAME + ')(?:\\s*\\[|\\s*\\(|\\s*:)')

// `val x: Int = 5`, `val y = "hello"`, `lazy val config = ...`, `private final val MAX = 5` Scala allows `val` to bind multiple names in pattern-match style (`val (a, b) = tuple`), but for simplicity we extract only the first word-boundary identifier after `val`.
const VAL_RE = new RegExp('^\\s*' + MODS + 'val\\s+(' + NAME + ')')

// `var x: Int = 5`, `var y = "hello"` — same pattern as val.
const VAR_RE = new RegExp('^\\s*' + MODS + 'var\\s+(' + NAME + ')')

// A Scala 3 given instance (Scala 3 Reference, "Contextual Abstractions" > "Given Instances"): `given intOrd: Ord[Int] with`, `given listOrd[T](using ord: Ord[T]): Ord[List[T]] with`, Scala 3.6's `given intOrd: Ord[Int]:` and `given [T: Ord] => Ord[List[T]]:`, an alias `given global: ExecutionContext = ForkJoinPool()` and an abstract `given c: Context`. The modifier list leaves out `case`, so a `case given Ord[T] =>` pattern is never read as a definition.
const GIVEN_RE = /^\s*(?:(?:(?:private|protected)(?:\[[A-Za-z_][A-Za-z0-9_]*\])?|inline|transparent|override|final|implicit|lazy)\s+)*given\s+(?!=(?!>))(\S.*)$/

const SIMPLE_TYPE_HEAD_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)\s*/

// Split `text` at the commas that sit outside every bracket and parenthesis.
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

// The name the compiler gives an anonymous given (Scala 3 Reference, "Given Instances" > "Anonymous Givens"): `given_`, the implemented type's simple name, then the simple name of each top-level type argument, a tuple argument contributing each of its members, so `given Ord[Int]` is `given_Ord_Int` and `given [T: Ord] => Ord[List[T]]` is `given_Ord_List`. A type this does not model (a function or refinement type) falls back to `given`.
function anonymousGivenName(typeText: string): string {
  let text = typeText.trim()
  // Scala 3.6 writes a conditional given's type and using clauses ahead of `=>`: drop each one.
  while (text.startsWith('[') || text.startsWith('(')) {
    let depth = 0
    let i = 0
    for (; i < text.length; i++) {
      const ch = text[i]!
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      if (depth === 0) break
    }
    const after = text.slice(i + 1).trimStart()
    if (!after.startsWith('=>')) return 'given'
    text = after.slice(2).trim()
  }
  const head = SIMPLE_TYPE_HEAD_RE.exec(text)
  if (!head) return 'given'
  const parts = [head[1]!]
  const tail = text.slice(head[0].length)
  if (tail !== '') {
    if (!tail.startsWith('[') || !tail.endsWith(']')) return 'given'
    for (const arg of splitTopLevel(tail.slice(1, -1))) {
      const members = arg.startsWith('(') && arg.endsWith(')') ? splitTopLevel(arg.slice(1, -1)) : [arg]
      for (const member of members) {
        // The same page names a function type used as a type argument `Function`.
        if (member.replace(/\[.*\]/g, '').includes('=>')) {
          parts.push('Function')
          continue
        }
        const m = SIMPLE_TYPE_HEAD_RE.exec(member)
        if (!m || !/^(?:\[.*\])?$/.test(member.slice(m[0].length))) return 'given'
        parts.push(m[1]!)
      }
    }
  }
  return `given_${parts.join('_')}`
}

// The given declared on `stripped`, or null when the line declares none. `body` says how its template body opens: `colon` for an indented body (a trailing `with` or Scala 3.6's trailing `:`), `brace` for `with {` or `{`, and null for an alias (`= expr`) or an abstract given, which have no body of their own. A colon before the body, outside every bracket, ends the signature, so the identifier ahead of it is the given's own name; with none the given is anonymous.
function givenHead(stripped: string): { name: string; anonymous: boolean; body: 'colon' | 'brace' | null } | null {
  const m = GIVEN_RE.exec(stripped)
  if (!m) return null
  const rest = m[1]!
  const blanked = stripStringLiterals(rest, SCALA_STRIP)
  let depth = 0
  let sigColon = -1
  let end = blanked.length
  let body: 'colon' | 'brace' | null = null
  for (let i = 0; i < blanked.length; i++) {
    const ch = blanked[i]!
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth !== 0) continue
    else if (ch === '{') {
      end = i
      body = 'brace'
      break
    } else if (ch === '=' && blanked[i + 1] !== '>') {
      end = i
      break
    } else if (ch === ':') {
      if (blanked.slice(i + 1).trim() === '') {
        end = i
        body = 'colon'
        break
      }
      if (sigColon < 0) sigColon = i
    } else if (blanked.startsWith('with', i) && !/[A-Za-z0-9_]/.test(blanked[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(blanked[i + 4] ?? '')) {
      end = i
      body = blanked.slice(i + 4).trim().startsWith('{') ? 'brace' : 'colon'
      break
    }
  }
  const sig = sigColon >= 0 ? rest.slice(0, sigColon).trim() : ''
  const named = new RegExp('^(' + NAME + ')\\s*(?:[[(]|$)').exec(sig)
  if (named) return { name: unquoteName(named[1]!), anonymous: false, body }
  return { name: anonymousGivenName(sigColon >= 0 ? rest.slice(sigColon + 1, end) : rest.slice(0, end)), anonymous: true, body }
}

// True when `stripped` opens any declaration this extractor recognizes. Used only by the stale-frame sweep, which needs to distinguish a real new declaration from a continuation line (`) extends Bar {`, `with Baz {`, a bare `{`) that must leave the open frame alone.
function startsDeclaration(stripped: string): boolean {
  return (
    CLASS_RE.test(stripped) ||
    OBJECT_RE.test(stripped) ||
    TRAIT_RE.test(stripped) ||
    ENUM_RE.test(stripped) ||
    FUNC_RE.test(stripped) ||
    VAL_RE.test(stripped) ||
    VAR_RE.test(stripped) ||
    GIVEN_RE.test(stripped) ||
    extensionClauseTail(stripped) !== null
  )
}

// What follows a Scala 3 extension clause (`extension (c: Circle)`, `extension [T](xs: List[T])(using o: Ordering[T])`) on its own line: a one-line `def ...`, a `{`, or nothing when its methods sit in the indented block below. Null when the line opens no extension clause, so a value or a call named `extension` is left alone.
function extensionClauseTail(stripped: string): string | null {
  if (!/^extension\s*[[(]/.test(stripped)) return null
  const blanked = stripStringLiterals(stripped, SCALA_STRIP)
  let i = 'extension'.length
  let depth = 0
  for (; i < blanked.length; i++) {
    const ch = blanked[i]!
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && ch !== ' ' && ch !== '\t') break
  }
  return depth === 0 ? stripped.slice(i).trim() : null
}

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
  let mlState: MultilineStringState | null = null
  // Last line that held code, which is where an indentation-syntax body ends once a dedent (or the end of the file) closes it.
  let lastCodeLine = 0
  // An open extension block: its methods are members of the scope the clause sits in, at the column and brace depth of the block's first line.
  let extBlock: { indent: number; depth: number; parent: string | undefined; bodyIndent: number | null; bodyDepth: number } | null = null

  // Widen an indentation-syntax type to its body. A closing `end Name` marker belongs to the span when it names the type.
  const closeColonFrame = (frame: TypeFrame, endLine: number): void => {
    const open = symbols[frame.symbolIndex]
    if (open !== undefined) symbols[frame.symbolIndex] = withSpanEnd(open, endLine, lines)
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line Scala `"""..."""` string spans first, state carried across lines, so braces inside one can never desync braceDepth and its content can never be read as a declaration. Skipped on lines that start already inside a block comment (mlState null) to avoid misreading comment prose that happens to contain opener-shaped text.
    let mlLine = rawLine
    if (mlState !== null || !inComment) {
      const masked = stripMultilineStringSpan(rawLine, mlState, 'scala')
      mlLine = masked.code
      mlState = masked.state
    }

    // Strip /* */ block-comment spans (state carried across lines via inComment) so braces inside commented-out code are not counted toward braceDepth.
    const { code: blockStripped, inComment: nextInComment } = stripBlockCommentSpan(mlLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment so braces/text after it are ignored.
    const line = stripLineComment(blockStripped, ['//'], SCALA_STRIP).trimEnd()
    const stripped = line.trim()

    if (!stripped) {
      const braceLine = stripStringLiterals(line, SCALA_STRIP)
      braceDepth += (braceLine.match(/\{/g) ?? []).length - (braceLine.match(/\}/g) ?? []).length
      continue
    }

    const isIndented = line[0] === ' ' || line[0] === '\t'
    const indent = indentOf(line)

    // Close every indentation-syntax frame this line has dedented out of, then record the body column of the innermost one still open. Done before any declaration matching so the frame stack reflects where this line actually sits.
    while (typeStack.length > 0) {
      const top = typeStack[typeStack.length - 1]!
      if (!top.colonBody || indent > top.declIndent) break
      typeStack.pop()
      const closesWithMarker = indent === top.declIndent && stripped === (top.endMarker ?? `end ${top.name}`)
      closeColonFrame(top, closesWithMarker ? lineNum : lastCodeLine)
      if (closesWithMarker) lastCodeLine = lineNum
    }
    lastCodeLine = lineNum
    const colonTop = typeStack.length > 0 && typeStack[typeStack.length - 1]!.colonBody ? typeStack[typeStack.length - 1]! : null
    if (colonTop !== null && colonTop.bodyIndent === null) {
      colonTop.bodyIndent = indent
      colonTop.bodyEntered = true
    }
    // True when this line is a direct member of the innermost indentation-syntax frame: same brace depth as the declaration and sitting exactly at the body column, so a continuation line of a member (`  def f =` followed by a deeper expression) is never mistaken for a member of its own.
    const inColonBody = colonTop !== null && braceDepth === colonTop.startDepth && indent === colonTop.bodyIndent

    // import
    const braceImportM = BRACE_IMPORT_RE.exec(stripped)
    if (braceImportM) {
      const base = braceImportM[1] ?? ''
      // Each selector may itself be a rename (`Old => New`) or the wildcard `_` -- for a rename the imported symbol is the left-hand (original) name, matching what call sites actually reference; a bare `_` means "everything under base", so keep it as base._ rather than emitting a bogus `base._` per underscore.
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

    // A bodyless type declaration -- `sealed trait Op` and `sealed abstract class Shape` (the two halves of the idiomatic Scala ADT), a plain `class Foo extends Bar`, or a Scala 3 indentation-syntax `object Foo:` -- never gets a `{`, so `bodyEntered` never flips and the frame the push above created would sit on typeStack forever. That permanently fails `typeDetectionGateOk` and silently drops every later declaration in the file, and any brace from a later sibling flips the stale frame's `bodyEntered`, so the sibling's members get attributed to the wrong parent. A declaration-shaped line whose brace depth has fallen back to the frame's start depth proves that frame's body is over (or never began), so sweep such frames off before the gate is evaluated. `openParens === 0` is required so a declaration still inside its own multi-line parameter list is not mistaken for a finished one, and the line must itself start a declaration so a continuation line such as `) extends Bar {` keeps its frame intact until the brace arrives.
    if (typeStack.length > 0 && startsDeclaration(stripped)) {
      while (typeStack.length > 0) {
        const top = typeStack[typeStack.length - 1]!
        // `!top.colonBody`: an indentation-syntax frame is popped by the dedent check above and nothing else, otherwise the first declaration in its body -- which is exactly a declaration-shaped line at the frame's own brace depth -- would sweep the frame away before its members could be attributed to it.
        if (!top.colonBody && braceDepth <= top.startDepth && top.openParens === 0) typeStack.pop()
        else break
      }
    }

    // class/object/trait — recognized at column 0 (top-level), or indented while one brace level inside another type's body (a real nested type member). Matches kotlin.ts's classDetectionGateOk pattern.
    const outerFrame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null
    const outerDepthInType = outerFrame !== null ? braceDepth - outerFrame.startDepth : 0
    const typeDetectionGateOk = typeStack.length === 0 || outerDepthInType === 1 || inColonBody
    // `matched` tracks whether this line was already classified as a class/object/trait/ func/val/var declaration. Unlike an early `continue`, classification must still fall through to the brace-counting block below so a same-line opening `{` (e.g. `class Foo {` or `def foo(): Unit = {`) is counted and can flip `bodyEntered` -- skipping that via `continue` was the original bug: a same-line brace was silently dropped, `bodyEntered` never flipped true, the frame never popped, and `typeDetectionGateOk` stayed false for every subsequent top-level declaration in the file (mirrors kotlin.ts's real pattern, which pushes the frame but does NOT `continue` -- it falls through to brace-counting).
    let matched = false

    // A Scala 3 indentation-syntax declaration ends in `:` and opens no brace on its own line (Scala 3 Reference, "Other New Features" > "Optional Braces"): `object Foo:`, `class Bar(x: Int) extends Baz:`, `trait Qux:`. A declaration that also opens a brace here keeps the brace-counted extent it has always had.
    const opensColonBody = stripped.endsWith(':') && !stripped.includes('{')

    const cm = typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? CLASS_RE.exec(stripped) : null
    if (cm) {
      const cname = unquoteName(cm[1] ?? '')
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, cname, 'class', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      typeStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false, openParens: 0, declIndent: indent, colonBody: opensColonBody, bodyIndent: null, symbolIndex: symbols.length - 1 })
      matched = true
    }

    const om = !matched && typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? OBJECT_RE.exec(stripped) : null
    if (om) {
      const oname = unquoteName(om[1] ?? '')
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, oname, 'object', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      typeStack.push({ name: oname, startDepth: braceDepth, bodyEntered: false, openParens: 0, declIndent: indent, colonBody: opensColonBody, bodyIndent: null, symbolIndex: symbols.length - 1 })
      matched = true
    }

    const tm = !matched && typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? TRAIT_RE.exec(stripped) : null
    if (tm) {
      const tname = unquoteName(tm[1] ?? '')
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, tname, 'trait', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      typeStack.push({ name: tname, startDepth: braceDepth, bodyEntered: false, openParens: 0, declIndent: indent, colonBody: opensColonBody, bodyIndent: null, symbolIndex: symbols.length - 1 })
      matched = true
    }

    const enm = !matched && typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? ENUM_RE.exec(stripped) : null
    if (enm) {
      const enname = unquoteName(enm[1] ?? '')
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, enname, 'enum', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      typeStack.push({ name: enname, startDepth: braceDepth, bodyEntered: false, openParens: 0, declIndent: indent, colonBody: opensColonBody, bodyIndent: null, symbolIndex: symbols.length - 1 })
      matched = true
    }

    // A given with a template body is an object holding its members; an alias or abstract given is a value of the type it names.
    const gm = !matched && typeDetectionGateOk && (!isIndented || typeStack.length > 0) ? givenHead(stripped) : null
    if (gm) {
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, gm.name, gm.body === null ? 'val' : 'object', lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      if (gm.body !== null) {
        typeStack.push({ name: gm.name, startDepth: braceDepth, bodyEntered: false, openParens: 0, declIndent: indent, colonBody: gm.body === 'colon', bodyIndent: null, symbolIndex: symbols.length - 1, ...(gm.anonymous ? { endMarker: 'end given' } : {}) })
      }
      matched = true
    }

    // Methods/functions nested inside a type, or top-level functions.
    const frame = typeStack.length > 0 ? typeStack[typeStack.length - 1]! : null

    // Scala 3 extension methods hang off an `extension (...)` clause, on its line or in a block below it, so neither the line-anchored FUNC_RE nor the type frames reach them; the block ends at the first line back at the clause's column and brace depth.
    if (extBlock !== null && braceDepth <= extBlock.depth && indent <= extBlock.indent) extBlock = null
    if (!matched && extBlock !== null) {
      if (extBlock.bodyIndent === null) {
        extBlock.bodyIndent = indent
        extBlock.bodyDepth = braceDepth
      }
      const fm = indent === extBlock.bodyIndent && braceDepth === extBlock.bodyDepth ? FUNC_RE.exec(stripped) : null
      if (fm) symbols.push(makeLineSymbol(filePath, unquoteName(fm[1] ?? ''), 'function', lineNum, stripped.slice(0, 200), extBlock.parent, lines, 'c'))
      matched = true
    }
    const memberSlot = frame === null ? !isIndented : braceDepth - frame.startDepth === 1 || (inColonBody && frame === colonTop)
    const extTail = !matched && memberSlot ? extensionClauseTail(stripped) : null
    if (extTail !== null) {
      const fm = FUNC_RE.exec(extTail)
      if (fm) symbols.push(makeLineSymbol(filePath, unquoteName(fm[1] ?? ''), 'function', lineNum, stripped.slice(0, 200), frame?.name, lines, 'c'))
      else extBlock = { indent, depth: braceDepth, parent: frame?.name, bodyIndent: null, bodyDepth: braceDepth }
      matched = true
    }

    if (!matched && frame !== null) {
      const depthInType = braceDepth - frame.startDepth
      // === 1, not >= 1: a local def inside a method body sits at depthInType 2+ (matches kotlin.ts/csharp.ts, which gate the same way). `inColonBody && frame === colonTop` is the indentation-syntax equivalent of `depthInType === 1`: same brace depth as the declaration, sitting exactly at the body column.
      if (depthInType === 1 || (inColonBody && frame === colonTop)) {
        const fm = FUNC_RE.exec(stripped)
        if (fm) {
          symbols.push(makeLineSymbol(filePath, unquoteName(fm[1] ?? ''), 'function', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          matched = true
        }

        const vm = !matched ? VAL_RE.exec(stripped) : null
        if (vm) {
          symbols.push(makeLineSymbol(filePath, unquoteName(vm[1] ?? ''), 'val', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          matched = true
        }

        if (!matched) {
          const varm = VAR_RE.exec(stripped)
          if (varm) {
            symbols.push(makeLineSymbol(filePath, unquoteName(varm[1] ?? ''), 'var', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          }
        }
      }
    } else if (!matched && frame === null && !isIndented) {
      // Top-level function/val/var (Scala script/worksheet style, or Scala 3's top-level definitions outside any object) -- matches kotlin.ts's top-level branch, which checks both TOP_FUN_RE and CONST_RE, rather than only the function regex.
      const fm = FUNC_RE.exec(stripped)
      if (fm) {
        symbols.push(makeLineSymbol(filePath, unquoteName(fm[1] ?? ''), 'function', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
        matched = true
      }

      const vm = !matched ? VAL_RE.exec(stripped) : null
      if (vm) {
        symbols.push(makeLineSymbol(filePath, unquoteName(vm[1] ?? ''), 'val', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
        matched = true
      }

      if (!matched) {
        const varm = VAR_RE.exec(stripped)
        if (varm) {
          symbols.push(makeLineSymbol(filePath, unquoteName(varm[1] ?? ''), 'var', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
        }
      }
    }

    // A definition that ends its line in `=` with no brace has its body on the deeper-indented lines below it (`def f(x: Int): Int =` then an indented block), so its span runs through them.
    const lastSymbol = symbols[symbols.length - 1]
    if (lastSymbol !== undefined && lastSymbol.lineStart === lineNum && MEMBER_KINDS.has(lastSymbol.kind) && stripped.endsWith('=') && !stripped.includes('{')) {
      symbols[symbols.length - 1] = withSpanEnd(lastSymbol, indentedBodyEnd(lines, lineNum, indent), lines)
    }

    // Brace-count on a string-stripped copy
    const braceLine = stripStringLiterals(line, SCALA_STRIP)

    // Track the innermost frame's unclosed parentheses until its body opens, so the stale-frame sweep above can tell a finished bodyless declaration from one whose parameter list is still open across several lines.
    if (frame !== null && !frame.bodyEntered) {
      const parenDelta = (braceLine.match(/\(/g) ?? []).length - (braceLine.match(/\)/g) ?? []).length
      frame.openParens = Math.max(0, frame.openParens + parenDelta)
    }

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
      // `!top.colonBody`: an indentation-syntax frame sits at the same brace depth as its whole body, so this brace-based test would pop it on its first member line. The dedent check at the top of the loop is what ends it.
      if (!top.colonBody && top.bodyEntered && braceDepth <= top.startDepth) {
        typeStack.pop()
      } else {
        break
      }
    }
  }

  // A colon body running to the end of the file has no dedent to close it.
  while (typeStack.length > 0) {
    const top = typeStack.pop()!
    if (top.colonBody) closeColonFrame(top, lastCodeLine)
  }

  return { symbols, imports }
}
