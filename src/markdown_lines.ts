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
    const fm = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fm !== null && fm[1] !== undefined) {
      const run = fm[1]
      const ch = run[0] ?? ''
      if (fence === null) {
        fence = { ch, len: run.length }
      } else if (ch === fence.ch && run.length >= fence.len) {
        // Per CommonMark, a fence only closes on a run of the same character
        // with length >= the opening run's length; a shorter same-char run
        // (e.g. a nested ``` example inside an outer ```` fence) is literal
        // content, not a closing delimiter.
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    yield [i, line]
  }
}
