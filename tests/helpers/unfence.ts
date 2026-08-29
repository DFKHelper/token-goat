/**
 * Helpers for tests whose subject is NOT the untrusted-content fence.
 *
 * Third-party text (a fetched page, an MCP result, a document body, a recall listing) is now fenced
 * by provenance on every path, so a test about caching, dedup, compression, or filtering sees the
 * fence wrapper whether it cares about it or not. Stripping the wrapper here keeps those tests
 * asserting their own subject instead of restating the fence's format in a dozen places -- which
 * would make the fence's own wording unchangeable without touching unrelated files.
 *
 * Tests whose subject IS the fence must not use {@link unfence}: they assert the literal notice and
 * tags, so that the format stays pinned somewhere.
 */

/** The notice line the fence prepends, in both its no-match and its match-naming forms. */
const NOTICE_RE = /^\[token-goat: (?:content below is untrusted|\d+ prompt-injection pattern).*\]\n/

/**
 * Strip one untrusted-content fence (notice line, opening tag, closing tag) from `text`.
 *
 * Returns `text` unchanged when it carries no fence, so a test can call this unconditionally
 * without asserting in advance whether the path under test fences. It deliberately does NOT undo
 * `neutralizeFenceMarkers`, so a payload that itself contained a fence marker stays visibly
 * neutralized -- silently restoring it would hide the escaping bug that neutralization exists for.
 */
export function unfence(text: string): string {
  const withoutNotice = text.replace(NOTICE_RE, '')
  const fence = /^<(untrusted-[a-z-]+)>\n([\s\S]*)\n<\/\1>$/.exec(withoutNotice.trimEnd())
  if (fence === null) return text
  return fence[2] ?? text
}

/** The fence tag wrapping `text`, or null when it carries no fence. */
export function fenceTagOf(text: string): string | null {
  const fence = /<(untrusted-[a-z-]+)>\n[\s\S]*\n<\/\1>/.exec(text)
  return fence?.[1] ?? null
}

/** True when `text` carries a fence, whatever its tag and whichever notice form it used. */
export function isFenced(text: string): boolean {
  return fenceTagOf(text) !== null
}
