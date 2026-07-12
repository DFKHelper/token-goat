import type { SymbolEntry } from '../parser_types.js'
import { buildLineIndex, offsetToLine, stripCstyleComments, stripStringLiterals } from './common.js'

const MAX_SYMBOLS = 500
const IDENT = '[A-Za-z_][A-Za-z0-9_]*'
const MODIFIER =
  '(?:public|private|protected|global|static|final|override|virtual|abstract|webservice|testMethod|transient|with|without|inherited|sharing)'

const TYPE_DECL_RE = new RegExp(
  `^[ \\t]*(?:${MODIFIER}[ \\t]+)*(class|interface|enum)[ \\t]+(${IDENT})\\b[^\\n{;]*`,
  'gm',
)
const TRIGGER_RE = new RegExp(
  `^[ \\t]*trigger[ \\t]+(${IDENT})[ \\t]+on[ \\t]+([A-Za-z_][A-Za-z0-9_.]*)[ \\t]*\\([^\\n)]*\\)`,
  'gm',
)
const METHOD_RE = new RegExp(
  `^[ \\t]*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\\([^\\n)]*\\))?[ \\t]+)*(?:${MODIFIER}[ \\t]+)+(?:[A-Za-z_][A-Za-z0-9_.<>?,\\[\\] ]*[ \\t]+)?(${IDENT})[ \\t]*\\([\\s\\S]*?\\)[ \\t]*(?:\\{|;)`,
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

interface Span {
  readonly startLine: number
  readonly endLine: number
  readonly body: string
}

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  span: Span,
  docstring = '',
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: span.startLine,
    lineEnd: span.endLine,
    body: span.body,
    docstring,
  }
}

function lineStartOffset(lineIndex: readonly number[], line: number): number {
  return lineIndex[Math.max(0, line - 1)] ?? 0
}

function lineEndOffset(content: string, lineIndex: readonly number[], line: number): number {
  return line < lineIndex.length ? (lineIndex[line] ?? content.length) : content.length
}

function annotationStartLine(lines: readonly string[], line: number): number {
  let start = line
  for (let i = line - 2; i >= 0; i--) {
    const trimmed = lines[i]?.trim() ?? ''
    if (trimmed.startsWith('@')) {
      start = i + 1
      continue
    }
    if (trimmed === '') continue
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
): Span {
  const blockEndLine = findBlockEndLine(code, lineIndex, startOffset)
  const startOffsetForBody = lineStartOffset(lineIndex, bodyStartLine)
  const endLine = blockEndLine ?? offsetToLine(lineIndex, startOffset)
  const endOffset = lineEndOffset(content, lineIndex, endLine)
  return {
    startLine: bodyStartLine,
    endLine,
    body: content.slice(startOffsetForBody, endOffset).trimEnd(),
  }
}

function overlapsExisting(symbols: readonly SymbolEntry[], line: number): boolean {
  return symbols.some((s) => line >= s.lineStart && line <= s.lineEnd && s.kind !== 'apex_class')
}

export function extractApex(content: string, filePath: string): { symbols: SymbolEntry[] } {
  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  const lineIndex = buildLineIndex(content)
  const rawLines = content.split(/\r?\n/)
  // String literals must be blanked BEFORE `//` line-comment stripping: stripCstyleComments's
  // `lineCommentRe` application is not quote-aware, so a `//` inside a string (e.g. a URL literal
  // like 'https://example.com') would otherwise be treated as a real comment starter and blank
  // everything through end-of-line, corrupting any code that follows on the same line.
  const stringFree = stripStringLiterals(content)
  const code = stripCstyleComments(stringFree, /\/\/.*$/gm)

  const emit = (name: string, kind: string, span: Span, docstring = ''): void => {
    if (!name || symbols.length >= MAX_SYMBOLS) return
    const key = `${name}\0${kind}\0${span.startLine}`
    if (seen.has(key)) return
    seen.add(key)
    symbols.push(makeSymbol(filePath, name, kind, span, docstring))
  }

  for (const match of code.matchAll(TRIGGER_RE)) {
    const name = match[1] ?? ''
    const objectName = match[2] ?? ''
    const startOffset = match.index ?? 0
    const line = offsetToLine(lineIndex, startOffset)
    emit(name, 'apex_trigger', spanForMatch(content, code, lineIndex, startOffset, line), objectName)
  }

  const typeNames = new Set<string>()
  for (const match of code.matchAll(TYPE_DECL_RE)) {
    const typeKind = match[1] ?? ''
    const name = match[2] ?? ''
    const startOffset = match.index ?? 0
    const line = offsetToLine(lineIndex, startOffset)
    const kind = typeKind === 'class' ? 'apex_class' : `apex_${typeKind}`
    typeNames.add(name)
    emit(name, kind, spanForMatch(content, code, lineIndex, startOffset, line))
  }

  for (const match of code.matchAll(METHOD_RE)) {
    const name = match[1] ?? ''
    if (CONTROL_NAMES.has(name)) continue
    const startOffset = match.index ?? 0
    const line = offsetToLine(lineIndex, startOffset)
    if (overlapsExisting(symbols, line)) continue
    const bodyStartLine = annotationStartLine(rawLines, line)
    const kind = typeNames.has(name) ? 'apex_constructor' : 'apex_method'
    emit(name, kind, spanForMatch(content, code, lineIndex, startOffset, bodyStartLine))
  }

  return { symbols }
}
