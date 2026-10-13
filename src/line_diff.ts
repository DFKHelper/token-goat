/** Line-level comparison helpers shared by the Write pre-hook and its guards (hooks_write.ts, write_guards.ts). */

/** Split into lines, without the phantom trailing element a final newline produces. `'a\nb\n'.split(/\n/)` is `['a', 'b', '']`: three elements for a two-line file. Both numbers the Write hook reports were computed from that array, so a 40-line file was described as a "41-line file", and the empty element matched its counterpart in the new content on every comparison, adding a free +1 to the unchanged count -- 30 of 40 lines kept was reported as 76% rather than 75%. Nearly every text file ends in a newline, so this was the normal case, not an edge one, and both figures appear verbatim in the message the model is shown. The minimum-lines gate read the same inflated count, so a file one line short of the threshold passed it. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Length of the longest common subsequence between two line arrays, via the standard O(n*m) time / O(min(n,m)) space DP (two rolling rows, always iterating the shorter side as the inner loop). Order-respecting by construction -- unlike a multiset/bag-of-lines intersection, lines that recur out of order don't inflate the "unchanged" count, so a genuine full-file rewrite that happens to share some common lines (imports, boilerplate) doesn't masquerade as a small edit. */
export function lcsLength(a: string[], b: string[]): number {
  const [shortArr, longArr] = a.length <= b.length ? [a, b] : [b, a]
  const n = shortArr.length
  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= longArr.length; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = shortArr[j - 1] === longArr[i - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n] ?? 0
}
