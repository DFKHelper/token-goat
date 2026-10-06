/** Splitting one source line into the declarations a type body written on that line holds, for the line-at-a-time adapters whose member matchers anchor at the start of a line: `class Single { function alpha() { return 1; } private $x = 1; const K = 2; }` declares three members, and a matcher run on the whole line sees only the class. Shared by every adapter with that shape, so where one member ends is decided once. */

/** One declaration's slice of a line: `code.slice(start, end)`. `open` is set on the last slice when a block it opened is still open at the end of the line, so the member's body runs on into later lines. */
export interface BodySegment {
  readonly start: number
  readonly end: number
  readonly open: boolean
}

/** The declarations in `code` from `from` on, where `from` sits just inside a body's opening brace or at the start of a line that is already inside one. A declaration ends at a `;`, or at the `}` closing a block it opened, outside every parenthesis and bracket; the scan stops at the `}` that closes the body itself. `code` must have its string literals and comments blanked, offset for offset, so a brace or `;` inside one is text. Slices holding nothing but whitespace and `;` are left out. */
export function bodySegments(code: string, from: number): BodySegment[] {
  const out: BodySegment[] = []
  let braces = 0
  let nest = 0
  let start = from
  const cut = (end: number): void => {
    if (/[^\s;]/.test(code.slice(start, end))) out.push({ start, end, open: false })
    start = end
  }
  for (let i = from; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(' || ch === '[') nest++
    else if (ch === ')' || ch === ']') nest = Math.max(0, nest - 1)
    else if (ch === '{') braces++
    else if (ch === '}') {
      if (braces === 0) {
        cut(i)
        return out
      }
      braces--
      if (braces === 0 && nest === 0) cut(i + 1)
    } else if (ch === ';' && braces === 0 && nest === 0) cut(i + 1)
  }
  if (/[^\s;]/.test(code.slice(start))) out.push({ start, end: code.length, open: braces > 0 })
  return out
}
