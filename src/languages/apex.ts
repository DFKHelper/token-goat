import type { SymbolEntry } from '../parser_types.js'
import { buildLineIndex, offsetToLine, stripCstyleComments, stripStringLiterals, type AdapterSpan, makeSpanSymbol } from './common.js'
import { escapeRegExp } from '../util.js'

const MAX_SYMBOLS = 500
const IDENT = '[A-Za-z_][A-Za-z0-9_]*'
const MODIFIER =
  '(?:public|private|protected|global|static|final|override|virtual|abstract|webservice|testMethod|transient|with|without|inherited|sharing)'

// Same leading-annotation allowance as METHOD_RE below (`@IsTest private class MyTestClass { ... }`
// is a common, legal Apex idiom) - without it, an annotated type declaration line fails to match
// at all, silently dropping the type and misattributing every member inside it.
const TYPE_DECL_RE = new RegExp(
  `^[ \\t]*(?:@${IDENT}(?:\\([^\\n)]*\\))?[ \\t]+)*(?:${MODIFIER}[ \\t]+)*(class|interface|enum)[ \\t]+(${IDENT})\\b[^\\n{;]*`,
  'gm',
)
const TRIGGER_RE = new RegExp(
  `^[ \\t]*trigger[ \\t]+(${IDENT})[ \\t]+on[ \\t]+([A-Za-z_][A-Za-z0-9_.]*)[ \\t]*\\([^\\n)]*\\)`,
  'gm',
)
// Apex allows a method/constructor to be declared with no access modifier at all (implicitly
// private), and interface method signatures never carry a modifier at all - so the modifier
// group alone cannot be mandatory (it used to be `+`, silently dropping every such method).
// But this extractor runs matchAll over the whole file with no brace-depth tracking, unlike
// the line-by-line C# extractor's METHOD_RE, so simply relaxing the modifier group to `*`
// lets a plain no-modifier statement call inside a method body (`someHelper(input);`,
// `return calculate(a, b);`) match as if it were its own method declaration. The fix requires
// at least one of {a modifier, a return type} to be present - a bare call has neither - and
// guards the modifier-less branch against a statement-leading keyword (`return`/`throw`/`new`/
// etc.) being mistaken for the return type, which the modifier-mandatory branch never needs
// since none of MODIFIER's keywords overlap with those statement keywords.
const RETURN_TYPE = '(?:[A-Za-z_][A-Za-z0-9_.<>?,\\[\\] ]*[ \\t]+)'
const STATEMENT_KEYWORD_GUARD = '(?!(?:return|throw|new|yield|else|do|try|finally|break|continue)\\b)'
const METHOD_RE = new RegExp(
  `^[ \\t]*(?:@${IDENT}(?:\\([^\\n)]*\\))?[ \\t]+)*` +
    `(?:(?:${MODIFIER}[ \\t]+)+${RETURN_TYPE}?|(?:${MODIFIER}[ \\t]+)*${STATEMENT_KEYWORD_GUARD}${RETURN_TYPE})` +
    `(${IDENT})[ \\t]*\\([\\s\\S]*?\\)[ \\t]*(?:\\{|;)`,
  'gm',
)

const CONTROL_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'new',
])

function lineStartOffset(lineIndex: readonly number[], line: number): number {
  return lineIndex[Math.max(0, line - 1)] ?? 0
}

function lineEndOffset(content: string, lineIndex: readonly number[], line: number): number {
  return line < lineIndex.length ? (lineIndex[line] ?? content.length) : content.length
}

// A line "starts with @" is not sufficient to be a standalone annotation line to fold into the
// span above: a type declaration itself can carry a leading same-line annotation
// (`@IsTest private class MyTestClass {`), and that line must never be mistaken for one of the
// preceding pure-annotation lines a method/constructor's own span walks back through - doing so
// swallows the class's own header line into the member's span instead of the class's.
const PURE_ANNOTATION_LINE_RE = new RegExp(`^(?:@${IDENT}(?:\\([^)]*\\))?[ \\t]*)+$`)
// An annotation's own argument list is legally allowed to span multiple physical lines
// (`@InvocableMethod(\n    label='Do something'\n    description='...'\n)`, idiomatic for
// Flow-invocable methods) - PURE_ANNOTATION_LINE_RE alone can never match any of those lines
// individually since none of them is a self-contained, paren-balanced annotation on its own.
// Without this, the fold-back below stops at the first such line and silently drops the whole
// annotation from the member's span, the same failure mode the same-line/standalone-single-line
// cases above were already fixed for.
const ANNOTATION_OPENER_RE = new RegExp(`^@${IDENT}\\(`)

function annotationStartLine(lines: readonly string[], line: number): number {
  let start = line
  let depth = 0
  for (let i = line - 2; i >= 0; i--) {
    const trimmed = lines[i]?.trim() ?? ''
    if (depth === 0 && trimmed === '') continue
    if (depth === 0 && PURE_ANNOTATION_LINE_RE.test(trimmed)) {
      start = i + 1
      continue
    }
    const opens = (trimmed.match(/\(/g) ?? []).length
    const closes = (trimmed.match(/\)/g) ?? []).length
    const nextDepth = depth + closes - opens
    if (nextDepth > 0) {
      // Still inside an annotation argument list whose closing paren was already consumed below.
      depth = nextDepth
      continue
    }
    if (nextDepth === 0 && ANNOTATION_OPENER_RE.test(trimmed)) {
      // This line opens the multi-line annotation argument list; fold it (and everything below
      // it that was already consumed) into the member's span.
      depth = 0
      start = i + 1
      continue
    }
    break
  }
  return start
}

function findBlockEndLine(code: string, lineIndex: readonly number[], fromOffset: number): number | null {
  const open = code.indexOf('{', fromOffset)
  if (open === -1) return null

  let depth = 0
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return offsetToLine(lineIndex, i)
    }
  }
  return null
}

function spanForMatch(
  content: string,
  code: string,
  lineIndex: readonly number[],
  startOffset: number,
  bodyStartLine: number,
  matchText: string,
): AdapterSpan {
  // A brace-less declaration (an abstract/interface method signature, permitted by METHOD_RE's
  // `(?:\{|;)` terminator alternation) has no body of its own to span. Calling findBlockEndLine
  // here would search past this declaration for the next `{` in the file, which belongs to
  // whatever concrete method happens to follow - over-extending this span to swallow that
  // method's entire body (and, via overlapsExisting, dropping it from the index outright).
  const semicolonTerminated = matchText.trimEnd().endsWith(';')
  const startOffsetForBody = lineStartOffset(lineIndex, bodyStartLine)
  const endLine = semicolonTerminated
    ? offsetToLine(lineIndex, startOffset + matchText.length - 1)
    : (findBlockEndLine(code, lineIndex, startOffset) ?? offsetToLine(lineIndex, startOffset))
  const endOffset = lineEndOffset(content, lineIndex, endLine)
  return {
    startLine: bodyStartLine,
    endLine,
    body: content.slice(startOffsetForBody, endOffset).trimEnd(),
  }
}

// A type-container span (class, interface, or enum body) must never suppress a method that falls
// inside it - otherwise a brace-less interface/enum method signature, which legally shares lines
// with its own container's span, would be silently dropped from the index.
const CONTAINER_KINDS = new Set(['apex_class', 'apex_interface', 'apex_enum'])

function overlapsExisting(symbols: readonly SymbolEntry[], line: number): boolean {
  return symbols.some(
    (s) => line >= s.lineStart && line <= s.lineEnd && !CONTAINER_KINDS.has(s.kind),
  )
}

export function extractApex(content: string, filePath: string): { symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  const lineIndex = buildLineIndex(content)
  // Block comments must be stripped BEFORE string-literal blanking, not after: `stripCstyleComments`
  // already skips a `/*` opener that falls inside an open quote (isInsideStringLiteral), so it does
  // not need string-free input to find real comment spans. Doing it the other way around - as this
  // used to - lets a lone apostrophe from a contraction inside a `/* */` comment (e.g. "won't") get
  // misread by `stripStringLiterals` as a string opener, blanking from the apostrophe to end-of-line
  // and eating the comment's own same-line closing `*/` along with it. `stripCstyleComments` then
  // finds an orphaned unclosed `/*` and blanks everything through EOF. Stripping block comments
  // first removes the apostrophe (and the rest of the comment body) before `stripStringLiterals`
  // ever sees it, so it can no longer be mistaken for a string opener.
  const blockCommentFree = stripCstyleComments(content)
  // String literals must be blanked BEFORE `//` line-comment stripping: stripCstyleComments's
  // `lineCommentRe` application is not quote-aware, so a `//` inside a string (e.g. a URL literal
  // like 'https://example.com') would otherwise be treated as a real comment starter and blank
  // everything through end-of-line, corrupting any code that follows on the same line.
  const stringFree = stripStringLiterals(blockCommentFree)
  const code = stripCstyleComments(stringFree, /\/\/.*$/gm)
  // annotationStartLine's paren-depth counter must walk this string/comment-blanked `code` text,
  // not the raw source: a literal `(`/`)` inside a multi-line annotation's own string argument
  // (e.g. `label='Do something ('`) is real code-adjacent text on a raw line but not a real paren,
  // and counting it as one desyncs the depth tracker - either breaking the walk-back early (silently
  // dropping the whole annotation fold, the very failure mode the multi-line-annotation fix above
  // already covers for the no-parens case) or over/under-folding into unrelated lines.
  const codeLines = code.split(/\r?\n/)

  const emit = (name: string, kind: string, span: AdapterSpan, docstring = ''): void => {
    if (!name || symbols.length >= MAX_SYMBOLS) return
    const key = `${name}\0${kind}\0${span.startLine}`
    if (seen.has(key)) return
    seen.add(key)
    symbols.push(makeSpanSymbol(filePath, name, kind, span, docstring))
  }

  for (const match of code.matchAll(TRIGGER_RE)) {
    const name = match[1] ?? ''
    const objectName = match[2] ?? ''
    const startOffset = match.index ?? 0
    const line = offsetToLine(lineIndex, startOffset)
    const bodyStartLine = annotationStartLine(codeLines, line)
    emit(name, 'apex_trigger', spanForMatch(content, code, lineIndex, startOffset, bodyStartLine, match[0]), objectName)
  }

  // A standalone `@IsTest`/`@SuppressWarnings(...)` annotation line directly above a class/
  // interface/enum declaration (`@IsTest\npublic class MyTestClass { ... }`) is at least as
  // common in real Apex as the same-line form (`@IsTest private class MyTestClass { ... }`)
  // the comment above TYPE_DECL_RE already handles -- @IsTest on its own line is in fact the
  // more idiomatic style for Apex test classes. TYPE_DECL_RE, like TRIGGER_RE, only matches
  // annotations glued to the same physical line as the keyword, so a preceding standalone
  // annotation line was silently excluded from the emitted span/body and lineStart pointed at
  // the class keyword instead of its real declaration start -- the same span-folding
  // annotationStartLine already applies to constructors/methods below, just not here.
  const typeNames = new Set<string>()
  for (const match of code.matchAll(TYPE_DECL_RE)) {
    const typeKind = match[1] ?? ''
    const name = match[2] ?? ''
    const startOffset = match.index ?? 0
    const line = offsetToLine(lineIndex, startOffset)
    const bodyStartLine = annotationStartLine(codeLines, line)
    const kind = typeKind === 'class' ? 'apex_class' : `apex_${typeKind}`
    typeNames.add(name)
    emit(name, kind, spanForMatch(content, code, lineIndex, startOffset, bodyStartLine, match[0]))
  }

  // A constructor may legally omit an access modifier entirely (implicitly private), same as any
  // other method - but unlike a method, a constructor also has no return type, so METHOD_RE's
  // modifier-less branch (which mandates a return-type token) can never match a bare
  // `Foo() { ... }` line. That shape is unambiguous once the type names are known: a bare
  // identifier immediately followed by parens and a `{`, matching a declared type name, cannot be
  // anything but that type's constructor - a call statement ends in `;`, never `{`. Pick it up with
  // a second, name-anchored pass now that typeNames has been collected. `[^;{}]*` (not `[\s\S]*?`)
  // keeps the parameter-list match on one line so it can't lazily span into an unrelated brace on a
  // later line.
  if (typeNames.size > 0) {
    const namesAlt = [...typeNames].map(escapeRegExp).join('|')
    const ctorNoModifierRe = new RegExp(`^[ \\t]*(${namesAlt})[ \\t]*\\([^;{}]*\\)[ \\t]*\\{`, 'gm')
    for (const match of code.matchAll(ctorNoModifierRe)) {
      const name = match[1] ?? ''
      const startOffset = match.index ?? 0
      const line = offsetToLine(lineIndex, startOffset)
      if (overlapsExisting(symbols, line)) continue
      const bodyStartLine = annotationStartLine(codeLines, line)
      emit(name, 'apex_constructor', spanForMatch(content, code, lineIndex, startOffset, bodyStartLine, match[0]))
    }
  }

  for (const match of code.matchAll(METHOD_RE)) {
    const name = match[1] ?? ''
    if (CONTROL_NAMES.has(name)) continue
    const startOffset = match.index ?? 0
    const line = offsetToLine(lineIndex, startOffset)
    if (overlapsExisting(symbols, line)) continue
    const bodyStartLine = annotationStartLine(codeLines, line)
    const kind = typeNames.has(name) ? 'apex_constructor' : 'apex_method'
    emit(name, kind, spanForMatch(content, code, lineIndex, startOffset, bodyStartLine, match[0]))
  }

  return { symbols }
}
