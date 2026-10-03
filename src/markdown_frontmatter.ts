/** Index of the first line after a leading front-matter block, or 0 when the document has none. Line 1 (after an optional BOM, ignoring trailing whitespace) must be exactly `---` (YAML) and a later line exactly `---` or `...`, or exactly `+++` (the Hugo/Zola TOML fence) closed by a later `+++`; an unclosed fence is not front matter. The markdown scanners start here so the closing `---` never underlines the last metadata key as a setext heading and a TOML `# comment` is never read as a heading. */
export function frontMatterEndIndex(lines: readonly string[]): number {
  const first = lines[0]
  if (first === undefined) return 0
  const open = first.replace(/^\uFEFF/, '').trimEnd()
  if (open !== '---' && open !== '+++') return 0
  for (let i = 1; i < lines.length; i++) {
    const t = (lines[i] ?? '').trimEnd()
    if (t === open || (open === '---' && t === '...')) return i + 1
  }
  return 0
}
