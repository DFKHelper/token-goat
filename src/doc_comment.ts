/**
 * Shared doc-comment recovery, used by both the tree-sitter parser (`parser.ts`) and the
 * regex-based language adapters (`languages/common.ts`).
 *
 * Split into its own module rather than living in `parser.ts` (where it originated) because
 * `languages/common.ts` needs it too, and `parser.ts` already imports from `languages/common.ts`
 * (every regex extractor) -- importing `precedingDocComment` back the other way would create an
 * import cycle. `parser.ts` re-exports both symbols from here so existing callers/tests that
 * import them from `parser.js` keep working unchanged.
 */

/** Comment-syntax family {@link precedingDocComment} recognizes: `'c'` for `//`- and block-comment languages, `'hash'` for `#`-line-comment languages. */
export type DocCommentStyle = 'c' | 'hash'

/**
 * Derive a docstring from the comment block immediately above `lineStart` (1-indexed).
 *
 * Works off plain source lines rather than a syntax tree, so it applies equally to a tree-sitter
 * adapter (TS/JS, Rust) and a regex-based adapter -- both already have `lines` + a 1-indexed
 * start line and nothing else.
 *
 * ADJACENCY GUARD: the block must sit on the line *directly* above `lineStart` -- a blank line
 * between them, or a non-comment line, returns `''` rather than scanning further up. This is the
 * reason `docstring` was left unpopulated for every non-Python extractor in the first place (see
 * `boundSymbolDocstring`'s doc comment in parser.ts): without the guard, a file-level doc comment
 * would get attributed to every symbol beneath it -- the same shared-region blowup that once made
 * `body` grow quadratically -- and a comment block could get attached to more than one symbol
 * (the next symbol down would walk back through the same lines). Never scan past a blank line;
 * never widen the block once a non-comment line is hit.
 *
 * Callers that fold a leading decorator/attribute into a symbol's range (TS `@decorator`, Rust
 * `#[attr]`) pass the *already-widened* `lineStart` (the decorator/attribute's own line), so the
 * walk naturally looks above the decorator/attribute for the doc comment rather than between it
 * and the symbol.
 */
export function precedingDocComment(
  lines: readonly string[],
  lineStart: number,
  style: DocCommentStyle,
): string {
  // lineStart is 1-indexed; the line directly above it is lines[lineStart - 2].
  const aboveIdx = lineStart - 2
  if (aboveIdx < 0 || aboveIdx >= lines.length) return ''
  const aboveLine = lines[aboveIdx]
  if (aboveLine === undefined) return ''
  const aboveTrimmed = aboveLine.trim()

  if (style === 'hash') {
    if (!aboveTrimmed.startsWith('#')) return ''
    const collected: string[] = []
    let i = aboveIdx
    while (i >= 0) {
      const line = lines[i]
      if (line === undefined) break
      const trimmed = line.trim()
      if (!trimmed.startsWith('#')) break
      collected.unshift(trimmed.replace(/^#+\s?/, ''))
      i--
    }
    return collected.join('\n').trim()
  }

  // 'c' style: either a contiguous run of `//` (incl. `///`, `//!`) line comments, or a single
  // `/* ... */` / `/** ... */` block comment, immediately above.
  if (aboveTrimmed.endsWith('*/')) {
    let blockStart = aboveIdx
    while (blockStart >= 0) {
      const l = lines[blockStart]
      if (l === undefined) break
      if (l.trim().startsWith('/*')) break
      blockStart--
    }
    if (blockStart < 0) return ''
    const opener = lines[blockStart]
    if (opener === undefined || !opener.trim().startsWith('/*')) return ''
    return lines
      .slice(blockStart, aboveIdx + 1)
      .map((l) =>
        l
          .trim()
          .replace(/^\/\*+/, '')
          .replace(/\*+\/$/, '')
          .replace(/^\*\s?/, '')
          .trim(),
      )
      .filter((l) => l !== '')
      .join('\n')
  }

  if (aboveTrimmed.startsWith('//')) {
    const collected: string[] = []
    let i = aboveIdx
    while (i >= 0) {
      const line = lines[i]
      if (line === undefined) break
      const trimmed = line.trim()
      if (!trimmed.startsWith('//')) break
      collected.unshift(trimmed.replace(/^\/\/[/!]?\s?/, ''))
      i--
    }
    return collected.join('\n').trim()
  }

  return ''
}
