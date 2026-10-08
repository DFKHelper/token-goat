/** Linear replacements for the "tag start, anything up to `>`, lazy body, close tag" regexes that re-read the rest of a file from every start that never closes. A pattern like `<tag(?:\s[^>]*)?>([\s\S]*?)</tag>` has a cheap success path and an O(n) failure path, and a document of n unclosed starts takes the failure path n times. The rule these scanners use instead is that a failed search is final: when no `>` follows a start, none follows any later start either, and when no close tag follows the first start's open tag, none follows any later one. So the first miss ends the scan. */

/** One `<name ...>` open tag: `start` is the `<`, `nameEnd` the end of the part `open` matched, `end` one past the `>`. */
export interface OpenTag {
  readonly start: number
  readonly nameEnd: number
  readonly end: number
}

/** One `<name attrs>body</close>` element. `attrs` is the text between the name and the `>`, `body` the text between the open tag's `>` and the close tag. */
export interface Element extends OpenTag {
  readonly attrs: string
  readonly body: string
  readonly bodyEnd: number
}

/** A `text.indexOf('>', from)` that remembers its last answer, for callers that must keep scanning past a start that failed. Calls must pass non-decreasing `from`: the first `>` at or after a later position is then the remembered one whenever it is still ahead, and a remembered "none" stays none. Without it every failed start re-reads the stretch up to the same distant `>`. */
export function gtFinder(text: string): (from: number) => number {
  let cached = -2
  return (from) => {
    if (cached === -1) return -1
    if (cached >= from) return cached
    cached = text.indexOf('>', from)
    return cached
  }
}

/**
 * Every open tag whose name `open` matches, with the attribute text running to the first `>`. `open` must be a global regular expression matching `<` and the tag name only, and must end in a lookahead for whitespace or `>` where the old pattern's `(?:\s[^>]*)?>` required one.
 * Stops at the first start that has no `>` after it: every later start lacks one too.
 */
export function findOpenTags(text: string, open: RegExp): OpenTag[] {
  const out: OpenTag[] = []
  open.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = open.exec(text)) !== null) {
    const nameEnd = m.index + m[0].length
    const gt = text.indexOf('>', nameEnd)
    if (gt < 0) break
    out.push({ start: m.index, nameEnd, end: gt + 1 })
    open.lastIndex = gt + 1
  }
  return out
}

/**
 * Every non-overlapping `<name attrs>body</close>` element, left to right, with the body running to the first `close` match after the open tag, as a lazy `[\s\S]*?` does. `close` must be a global regular expression matching the whole close tag.
 * Stops at the first start with no `>` after it, and at the first open tag with no close after it: neither can be followed by a start that fares better.
 */
export function findElements(text: string, open: RegExp, close: RegExp, limit = Infinity): Element[] {
  const out: Element[] = []
  open.lastIndex = 0
  let m: RegExpExecArray | null
  while (out.length < limit && (m = open.exec(text)) !== null) {
    const nameEnd = m.index + m[0].length
    const gt = text.indexOf('>', nameEnd)
    if (gt < 0) break
    close.lastIndex = gt + 1
    const c = close.exec(text)
    if (c === null) break
    const end = c.index + c[0].length
    out.push({ start: m.index, nameEnd, end, attrs: text.slice(nameEnd, gt), body: text.slice(gt + 1, c.index), bodyEnd: c.index })
    open.lastIndex = end
  }
  return out
}
