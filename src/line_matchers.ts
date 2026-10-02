/** Linear-time matchers for header-like lines. Each replaces a regex that backtracked quadratically on a long run of whitespace (a 500 KB single line stalled the shared indexing worker for about a minute) and is differentially tested against that regex. */

const ATX_OPEN_RE = /^(#{1,6})(\s+)/
const TABLE_OPEN_RE = /^\s*\[+/
const TOML_OPEN_RE = /^\s*\[/
const TABLE_TAIL_RE = /^\s*(?:[#;].*)?$/
const WS_RE = /\s/

/** Characters `.` refuses to match, which is what keeps a heading title on one line in the parser's regex. */
export const ATX_DOT_BREAK_RE = /[\n\r\u{2028}\u{2029}]/u
/** The section reader's title class is `[^\r\n]`, so only CR and LF end a title there. */
export const ATX_CLASS_BREAK_RE = /[\r\n]/

export interface AtxHeading {
  level: number
  name: string
}

/** Match an ATX heading (`## Title ##`). `lineBreak` is the set a title may not contain; `absorbTrailingSpace` is true when trailing whitespace is swallowed outside the title (the section reader's `\s*$`) rather than belonging to it. */
export function matchAtxHeading(line: string, lineBreak: RegExp, absorbTrailingSpace: boolean): AtxHeading | null {
  const open = ATX_OPEN_RE.exec(line)
  if (open === null) return null
  const level = (open[1] as string).length
  const gap = open[2] as string
  const rest = line.slice(open[0].length)
  if (rest === '') {
    // A whitespace-only tail still matches when the regex can hand whitespace back to the title: one character, or any trailing one when trailing space is absorbed.
    if (gap.length < 2) return null
    const lowest = absorbTrailingSpace ? 1 : gap.length - 1
    for (let j = gap.length - 1; j >= lowest; j--) if (!lineBreak.test(gap.charAt(j))) return { level, name: '' }
    return null
  }
  const body = rest.trimEnd()
  let hashStart = body.length
  while (hashStart > 0 && body.charAt(hashStart - 1) === '#') hashStart--
  let title = absorbTrailingSpace ? body : rest
  if (hashStart < body.length && hashStart > 0 && WS_RE.test(body.charAt(hashStart - 1))) {
    // An optional closing run of hashes, preceded by whitespace, is not part of the title.
    let p = hashStart
    while (p > 0 && WS_RE.test(body.charAt(p - 1))) p--
    title = body.slice(0, p)
  }
  if (lineBreak.test(title)) return hashStart === 0 ? closingFromGap(gap, level, lineBreak) : null
  return { level, name: title.trim() }
}

/** A hash-only tail can serve as the closing run, leaving the whitespace before it to supply a one-character title. */
function closingFromGap(gap: string, level: number, lineBreak: RegExp): AtxHeading | null {
  for (let i = gap.length - 2; i >= 1; i--) if (!lineBreak.test(gap.charAt(i))) return { level, name: '' }
  return null
}

/** The raw name inside a TOML `[table]` or `[[array]]` header, or null. The caller trims. */
export function matchTomlSectionName(line: string): string | null {
  const open = TOML_OPEN_RE.exec(line)
  if (open === null) return null
  const close = line.indexOf(']', open[0].length)
  if (close < 0) return null
  const inner = line.slice(open[0].length, close)
  const start = inner.startsWith('[') ? 1 : 0
  let first = start
  while (first < inner.length && WS_RE.test(inner.charAt(first))) first++
  if (first < inner.length) return inner.slice(first)
  // Nothing but whitespace or a second bracket remains, so the regex gives one character back to the name.
  if (first > start) return inner.charAt(first - 1)
  return start === 1 ? '[' : null
}

/** The raw name in an INI/TOML table header line such as `[ name ]  # note`, or null. The caller trims. */
export function matchTableHeaderName(line: string): string | null {
  const open = TABLE_OPEN_RE.exec(line)
  if (open === null) return null
  const close = line.indexOf(']', open[0].length)
  if (close < 0) return null
  let after = close
  while (line.charAt(after) === ']') after++
  if (!TABLE_TAIL_RE.test(line.slice(after))) return null
  const inner = line.slice(open[0].length, close)
  let first = 0
  while (first < inner.length && WS_RE.test(inner.charAt(first))) first++
  if (first < inner.length) {
    let last = inner.length
    while (WS_RE.test(inner.charAt(last - 1))) last--
    return inner.slice(first, last)
  }
  if (first > 0) return inner.charAt(first - 1)
  // An empty inner part still matches when the bracket run can give its last bracket to the name.
  return open[0].trimStart().length >= 2 ? '[' : null
}

/** The title of a `# -- Name --` or `# === Name ===` banner, exactly as `^#\s*[-=]{2,}\s*(\S(?:.*?\S)?)\s*[-=]{2,}$` captures it, or null. That regex took seconds on a few thousand dashes; this tries each opening-run length once, longest first, and takes the shortest title of two or more characters before a one-character one, which is the order the regex backtracks in. */
export function matchRuleBannerTitle(line: string): string | null {
  const n = line.length
  if (line.charAt(0) !== '#') return null
  let p = 1
  while (p < n && WS_RE.test(line.charAt(p))) p++
  let run = 0
  while (p + run < n && isRuleChar(line.charAt(p + run))) run++
  let tail = 0
  while (tail < n && isRuleChar(line.charAt(n - 1 - tail))) tail++
  if (run < 2 || tail < 2) return null
  // The title may end where whitespace before the closing run starts, or inside that run while two of its characters remain.
  let wsStart = n - tail
  while (WS_RE.test(line.charAt(wsStart - 1))) wsStart--
  const firstEnd = (from: number): number => {
    if (from <= wsStart) return wsStart
    const end = Math.max(from, n - tail + 1)
    return end <= n - 2 ? end : -1
  }
  const nextBreak = lineBreakIndex(line)
  for (let k = run; k >= 2; k--) {
    let start = p + k
    if (k === run) while (start < n && WS_RE.test(line.charAt(start))) start++
    if (start >= n) continue
    const end = firstEnd(start + 2)
    if (end >= 0 && nextBreak(start) >= end) return line.slice(start, end)
    if (firstEnd(start + 1) === start + 1) return line.charAt(start)
  }
  return null
}

/** What `\s*(.+?)\s*$` (or `\s+` when `minGap` is 1) captures from `start` under the `m` flag: the rest of the line with its trailing whitespace dropped, or, when only whitespace remains in the whole text, the last character that is not a line break. */
export function matchRestOfLine(text: string, start: number, minGap: 0 | 1): string | null {
  const n = text.length
  let k = start
  while (k < n && WS_RE.test(text.charAt(k))) k++
  if (k - start < minGap) return null
  if (k < n) {
    let lineEnd = k
    while (lineEnd < n && !ATX_DOT_BREAK_RE.test(text.charAt(lineEnd))) lineEnd++
    return text.slice(k, lineEnd).trimEnd()
  }
  for (let m = n - 1; m >= start + minGap; m--) if (!ATX_DOT_BREAK_RE.test(text.charAt(m))) return text.charAt(m)
  return null
}

function isRuleChar(c: string): boolean {
  return c === '-' || c === '='
}

/** A lookup for the first character at or after an index that `.` refuses to match, or the line length when there is none. */
function lineBreakIndex(line: string): (from: number) => number {
  if (!ATX_DOT_BREAK_RE.test(line)) return () => line.length
  const next = new Array<number>(line.length + 1)
  next[line.length] = line.length
  for (let i = line.length - 1; i >= 0; i--) next[i] = ATX_DOT_BREAK_RE.test(line.charAt(i)) ? i : (next[i + 1] as number)
  return (from) => next[from] as number
}

export interface SelectorSpan {
  start: number
  end: number
}

/** The selector text before the first `{` of a CSS line, as `[start, end)`, or null. The leading-whitespace run may itself be given to the selector when the first real character cannot start one (`}` or `@`). */
export function matchCssSelectorSpan(line: string): SelectorSpan | null {
  const brace = line.indexOf('{')
  if (brace < 0) return null
  let indent = 0
  while (indent < line.length && (line.charAt(indent) === ' ' || line.charAt(indent) === '\t')) indent++
  let start = Math.min(indent, brace - 1)
  if (start >= 0 && (line.charAt(start) === '}' || line.charAt(start) === '@')) start--
  if (start < 0) return null
  return { start, end: brace }
}
