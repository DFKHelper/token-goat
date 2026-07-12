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
  let fence: { ch: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const fm = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fm !== null && fm[1] !== undefined) {
      const run = fm[1]
      const ch = run[0] ?? ''
      const rest = fm[2] ?? ''
      if (fence === null) {
        // An opening fence may carry an info string (e.g. ```js).
        fence = { ch, len: run.length }
      } else if (ch === fence.ch && run.length >= fence.len && rest.trim() === '') {
        // Per CommonMark, a fence only closes on a run of the same character
        // with length >= the opening run's length AND no trailing info string.
        // A shorter same-char run, a mismatched char, or a marker-looking line
        // with trailing content (e.g. a ```js line immediately following an
        // already-open fence) is literal fenced content, not a closing
        // delimiter, and must not desync the open/closed state.
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    yield [i, line]
  }
}
