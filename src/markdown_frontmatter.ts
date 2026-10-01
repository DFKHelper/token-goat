/** Index of the first line after a leading YAML front-matter block, or 0 when the document has none. Line 1 (after an optional BOM, ignoring trailing whitespace) must be exactly `---` and a later line exactly `---` or `...`; an unclosed fence is not front matter. The markdown scanners start here so the closing `---` never underlines the last metadata key as a setext heading. */
export function frontMatterEndIndex(lines: readonly string[]): number {
  const first = lines[0]
  if (first === undefined || first.replace(/^\uFEFF/, '').trimEnd() !== '---') return 0
  for (let i = 1; i < lines.length; i++) {
    const t = (lines[i] ?? '').trimEnd()
    if (t === '---' || t === '...') return i + 1
  }
  return 0
}
