/** Turns a golden label (`{file, symbol}` or `{file, heading}`) into the line span a hit has to overlap. Resolved from the source file itself, with the TypeScript compiler for code and a small ATX-heading scan for Markdown, never through token-goat's own index: a label resolved by the system under test would agree with that system's parser by construction, which is exactly the fixture the testing conventions rule out. */
import ts from 'typescript'
import type { RelevantSpan } from './metrics.js'

export interface GoldenLabel {
  readonly file: string
  readonly symbol?: string
  readonly heading?: string
}

export interface Span {
  readonly lineStart: number
  readonly lineEnd: number
}

function declName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isVariableDeclaration(node)
  ) {
    const n = node.name
    return n !== undefined && ts.isIdentifier(n) ? n.text : undefined
  }
  return undefined
}

/** Every declaration of `name` in a TypeScript source, as 1-based line spans. A `const` spans its whole statement, so `export const X = ...` starts on the `export` line the way a reader sees it. Leading JSDoc is excluded: it is not the definition, and counting it would let a hit on the comment above pass for one on the code. */
export function symbolSpans(source: string, fileName: string, name: string): Span[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const spans: Span[] = []
  const visit = (node: ts.Node): void => {
    if (declName(node) === name) {
      const outer = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node
      const start = sf.getLineAndCharacterOfPosition(outer.getStart(sf, false)).line + 1
      const end = sf.getLineAndCharacterOfPosition(outer.getEnd()).line + 1
      spans.push({ lineStart: start, lineEnd: end })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return spans
}

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Every ATX heading whose text is exactly `heading`, spanning from the heading line to the line before the next heading of the same or a higher level (or the end of the file). Lines inside fenced code are skipped, so a `# comment` in a shell block neither matches nor ends a section. */
export function headingSpans(source: string, heading: string): Span[] {
  const lines = source.split(/\r?\n/)
  const heads: { line: number; level: number; text: string }[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? ''
    const f = FENCE.exec(l)
    if (f !== null) {
      const marker = f[1] ?? ''
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const m = ATX.exec(l)
    if (m !== null) heads.push({ line: i + 1, level: (m[1] ?? '').length, text: (m[2] ?? '').trim() })
  }
  let last = lines.length
  while (last > 1 && (lines[last - 1] ?? '').trim() === '') last--
  const spans: Span[] = []
  heads.forEach((h, idx) => {
    if (h.text !== heading) return
    const next = heads.slice(idx + 1).find((o) => o.level <= h.level)
    spans.push({ lineStart: h.line, lineEnd: next === undefined ? last : next.line - 1 })
  })
  return spans
}

/** Resolves one label against the file's text. Throws when the name is not found, so a label gone stale after a rename fails loudly instead of scoring as a miss that looks like a retrieval regression. */
export function resolveLabel(label: GoldenLabel, source: string): RelevantSpan[] {
  const spans =
    label.symbol !== undefined
      ? symbolSpans(source, label.file, label.symbol)
      : label.heading !== undefined
        ? headingSpans(source, label.heading)
        : []
  if (spans.length === 0) throw new Error(`label does not resolve: ${label.file} :: ${label.symbol ?? label.heading ?? '(no symbol or heading)'}`)
  return spans.map((s) => ({ file: label.file, ...s }))
}
