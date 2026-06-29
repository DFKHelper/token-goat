/**
 * Iterate markdown lines, skipping fenced-code-block content (``` or ~~~ blocks)
 * and the fence delimiter lines themselves, so a `#` comment inside a code fence
 * is never mistaken for a heading. A fence closes only on its own marker char, so
 * a ``` block is not closed by a ~~~ line.
 *
 * Yields [lineIndex, lineText] for each content line.
 *
 * Single source of fence handling shared by the markdown symbol extractor and
 * the section header scanner.
 */
export function* eachUnfencedLine(lines: readonly string[]): Generator<[number, string]> {
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const fm = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fm !== null && fm[1] !== undefined) {
      const ch = fm[1][0] ?? null
      if (fence === null) fence = ch
      else if (fence === ch) fence = null
      continue
    }
    if (fence !== null) continue
    yield [i, line]
  }
}
