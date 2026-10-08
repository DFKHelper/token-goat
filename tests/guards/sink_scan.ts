/** Text-level helpers the display-safe sink guard uses to follow a value past the one line a sink sits on: a call that continues onto the next line, a local the value was assigned to first, and a helper that builds the sentence the sink prints. Operates on comment-stripped source. */

/** Index of the `)` closing the `(` at `open`, or -1. String, template and `${}` contents are skipped, so a parenthesis inside a message does not move the balance. */
export function matchingParen(code: string, open: number): number {
  const modes: Array<'code' | 'template'> = ['code']
  const depth: number[] = [0]
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!
    const mode = modes[modes.length - 1]!
    if (mode === 'template') {
      if (ch === '\\') i++
      else if (ch === '`') {
        modes.pop()
        depth.pop()
      } else if (ch === '$' && code[i + 1] === '{') {
        modes.push('code')
        depth.push(0)
        i++
      }
      continue
    }
    if (ch === '\'' || ch === '"') {
      for (i++; i < code.length && code[i] !== ch && code[i] !== '\n'; i++) if (code[i] === '\\') i++
    } else if (ch === '`') {
      modes.push('template')
      depth.push(0)
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth[depth.length - 1]!++
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth[depth.length - 1] === 0 && modes.length > 1 && ch === '}') {
        modes.pop()
        depth.pop()
        continue
      }
      depth[depth.length - 1]!--
      if (modes.length === 1 && depth[0] === 0 && ch === ')') return i
    }
  }
  return -1
}

/** Everything a sink call at `sinkAt` is handed, from just after its `(` to its closing `)`, joined over however many lines it spans; the rest of the first line when the call never closes (an unbalanced scan is treated as the single-line case rather than trusted). */
export function sinkArguments(code: string, sinkAt: number, sinkLength: number): { text: string; multiline: boolean } {
  const open = sinkAt + sinkLength - 1
  const close = matchingParen(code, open)
  const lineEnd = code.indexOf('\n', sinkAt)
  const end = lineEnd < 0 ? code.length : lineEnd
  if (close < 0 || close < end) return { text: code.slice(open + 1, end), multiline: false }
  return { text: code.slice(open + 1, close), multiline: true }
}

/** A function this file defines that returns text built from a string parameter spliced in with no escape, which is what a sink handed its result prints raw. */
export interface RawBuilder {
  readonly name: string
  readonly param: string
}

/** `function name(a: string, ...)` and `const name = (a: string) =>` definitions whose body interpolates one of their `string` parameters outside any neutralizer. The caller supplies what counts as a neutralizer, since that list lives with the guard. */
export function rawBuilders(code: string, covered: (scope: string) => boolean, scopeOf: (text: string, idx: number) => string): RawBuilder[] {
  const found: RawBuilder[] = []
  const header = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g
  for (const m of code.matchAll(header)) {
    const name = m[1] ?? m[2]
    if (name === undefined || m.index === undefined) continue
    const open = m.index + m[0].length - 1
    const close = matchingParen(code, open)
    if (close < 0) continue
    const params = [...code.slice(open + 1, close).matchAll(/([A-Za-z_$][\w$]*)\??\s*:\s*string\b/g)].map((p) => p[1]!)
    if (params.length === 0) continue
    const bodyStart = code.indexOf('{', close)
    const arrow = code.indexOf('=>', close)
    if (bodyStart < 0) continue
    // An arrow with an expression body has no `{` before the next statement; the scan then reads on to the end of the line, which is enough to see its template.
    const bodyEnd = arrow >= 0 && arrow < bodyStart && !/^\s*\{/.test(code.slice(arrow + 2)) ? code.indexOf('\n', arrow) : endOfBlock(code, bodyStart)
    if (bodyEnd < 0) continue
    const body = code.slice(close, bodyEnd)
    for (const param of params) {
      const use = new RegExp(String.raw`\$\{\s*${param}\s*\}`, 'g')
      for (const u of body.matchAll(use)) {
        if (u.index === undefined) continue
        if (!covered(scopeOf(body, u.index + 2))) {
          found.push({ name, param })
          break
        }
      }
    }
  }
  return found
}

function endOfBlock(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

/** Names this file assigns from an expression `tainted` flags, one entry per `const`/`let`, with what tainted it. The right-hand side runs to its statement's end: the matching paren of a call it opens, else the end of the line. */
export function assignedFrom(code: string, tainted: (rhs: string) => string | null): Array<{ name: string; via: string; line: number }> {
  const out: Array<{ name: string; via: string; line: number }> = []
  for (const m of code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)/g)) {
    if (m.index === undefined) continue
    const from = m.index + m[0].length
    const lineEnd = code.indexOf('\n', from)
    let end = lineEnd < 0 ? code.length : lineEnd
    const open = code.slice(from, end).search(/\(\s*$/)
    if (open >= 0) {
      const close = matchingParen(code, from + open)
      if (close >= 0) end = close + 1
    }
    // A ternary yields one of its branches, never its condition: `isVirtualIndexedPath(sym.filePath) ? SUFFIX : ''` prints a constant however tainted the test is.
    const rhs = code.slice(from, end)
    const ternary = rhs.search(/\s\?\s(?!\.)/)
    const via = tainted(ternary >= 0 ? rhs.slice(ternary + 2) : rhs)
    if (via !== null) out.push({ name: m[1]!, via, line: code.slice(0, m.index).split('\n').length })
  }
  return out
}
