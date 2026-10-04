/** At most `maxLen` characters of `text` with the character at `idx` a third of the way in (or as near as the text's edges allow), marked `...` on each side that was cut. Shared by recall's snippets and search's text-channel previews so a preview of a long line shows the match rather than the line's opening. Kept out of util.ts, which is a parser-fingerprint source: a helper no extractor calls should not reparse every index when it changes. */
export function snippetAround(text: string, idx: number, maxLen: number): string {
  const start = Math.max(0, idx - Math.floor(maxLen / 3))
  const end = Math.min(text.length, start + maxLen)
  return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
}
