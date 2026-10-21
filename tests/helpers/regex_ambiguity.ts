// Static check for the regex shape that backtracks catastrophically: two quantified parts that can match the same code point and sit next to each other (directly, or with only optional parts between), or a repeated alternation whose branches overlap. It decides by running every code point 0..0x10FFFF through each part, so the verdict does not depend on the clock, the machine or an input a test happened to pick.

type Quantified = { readonly min: number; readonly max: number }
type AtomNode = Quantified & { readonly kind: 'atom'; readonly src: string }
type GroupNode = Quantified & { readonly kind: 'group'; readonly alts: readonly (readonly Node[])[]; readonly look: boolean }
type Node = AtomNode | GroupNode

const MAX_CODE_POINT = 0x10ffff

function parseSequence(src: string, start: number): { alts: Node[][]; end: number } {
  const alts: Node[][] = [[]]
  let i = start
  const current = (): Node[] => alts[alts.length - 1] ?? []
  while (i < src.length) {
    const ch = src[i] ?? ''
    if (ch === ')') break
    if (ch === '|') {
      alts.push([])
      i++
      continue
    }
    let node: Node | null
    let next: number
    if (ch === '(') {
      const head = /^\((\?(?:<[=!]|[=!:]|<[A-Za-z_$][\w$]*>))?/.exec(src.slice(i))
      const prefix = head?.[0] ?? '('
      const inner = parseSequence(src, i + prefix.length)
      next = inner.end + 1
      const look = /^\(\?<?[=!]/.test(prefix)
      node = { kind: 'group', alts: inner.alts, look, min: 1, max: 1 }
    } else if (ch === '[') {
      let j = i + 1
      while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1
      next = j + 1
      node = { kind: 'atom', src: src.slice(i, next), min: 1, max: 1 }
    } else if (ch === '\\') {
      const esc = /^\\(?:[pP]\{[^}]*\}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|k<[^>]*>|.)/s.exec(src.slice(i))
      const text = esc?.[0] ?? '\\'
      next = i + text.length
      if (/^\\[1-9k]/.test(text)) throw new Error('unsupported backreference ' + text)
      node = { kind: 'atom', src: text, min: 1, max: 1 }
    } else {
      next = i + ((src.codePointAt(i) ?? 0) > 0xffff ? 2 : 1)
      node = { kind: 'atom', src: src.slice(i, next), min: 1, max: 1 }
    }
    i = next
    const quant = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/.exec(src.slice(i))
    if (quant !== null) {
      i += quant[0].length
      let min = 0
      let max = 1
      if (quant[1] === '*') max = Infinity
      else if (quant[1] === '+') [min, max] = [1, Infinity]
      else if (quant[1] === undefined) {
        min = Number(quant[2])
        max = quant[3] === undefined ? min : quant[4] === '' || quant[4] === undefined ? Infinity : Number(quant[4])
      }
      node = { ...node, min, max }
    }
    const zeroWidth = node.kind === 'atom' && /^(?:\^|\$|\\[bB])$/.test(node.src)
    if (!zeroWidth) current().push(node)
  }
  return { alts, end: i }
}

type Matcher = { readonly label: string; readonly test: (cp: number) => boolean; readonly variable: boolean }

function matcherFor(atom: AtomNode, flags: string): Matcher {
  const re = new RegExp('^(?:' + atom.src + ')$', flags)
  return { label: atom.src, test: (cp) => re.test(String.fromCodePoint(cp)), variable: atom.max > atom.min }
}

function edgeAtoms(seq: readonly Node[], side: 'first' | 'last'): AtomNode[] {
  const out: AtomNode[] = []
  const ordered = side === 'first' ? seq : [...seq].reverse()
  for (const node of ordered) {
    if (node.kind === 'atom') out.push(node)
    else if (!node.look) for (const alt of node.alts) out.push(...edgeAtoms(alt, side))
    if (node.min >= 1) break
  }
  return out
}

function overlap(a: Matcher, b: Matcher): number | null {
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (a.test(cp) && b.test(cp)) return cp
  }
  return null
}

function checkSequence(seq: readonly Node[], flags: string, found: string[]): void {
  for (const node of seq) {
    if (node.kind !== 'group') continue
    for (const alt of node.alts) checkSequence(alt, flags, found)
    if (node.look || node.max <= 1) continue
    const branches = node.alts.map((alt) => {
      if (alt.length !== 1 || alt[0]?.kind !== 'atom') throw new Error('unsupported repeated group shape')
      return matcherFor(alt[0], flags)
    })
    for (let a = 0; a < branches.length; a++) {
      for (let b = a + 1; b < branches.length; b++) {
        const left = branches[a]
        const right = branches[b]
        if (left === undefined || right === undefined) continue
        const cp = overlap(left, right)
        if (cp !== null) found.push('repeated alternatives ' + left.label + ' and ' + right.label + ' both match U+' + cp.toString(16))
      }
    }
  }
  for (let i = 0; i < seq.length; i++) {
    const left = seq[i]
    if (left === undefined || (left.kind === 'group' && left.look)) continue
    const leftEdges = left.kind === 'atom' ? [left] : edgeAtoms([left], 'last')
    for (let j = i + 1; j < seq.length; j++) {
      const right = seq[j]
      if (right === undefined || (right.kind === 'group' && right.look)) continue
      const rightEdges = right.kind === 'atom' ? [right] : edgeAtoms([right], 'first')
      for (const a of leftEdges) {
        for (const b of rightEdges) {
          if (a.max <= a.min || b.max <= b.min) continue
          const cp = overlap(matcherFor(a, flags), matcherFor(b, flags))
          if (cp !== null) found.push('adjacent ' + a.src + ' and ' + b.src + ' both match U+' + cp.toString(16))
        }
      }
      if (right.min >= 1) break
    }
  }
}

/** Every place `re` has two neighbouring variable-length parts, or a repeated alternation, that can consume the same code point; an empty list means none. A shape this reader does not understand throws, so it never reports a clean pass for a pattern it did not read. */
export function ambiguousParts(re: RegExp): string[] {
  const parsed = parseSequence(re.source, 0)
  const flags = re.flags.replace(/[gy]/g, '')
  const found: string[] = []
  for (const alt of parsed.alts) checkSequence(alt, flags, found)
  return [...new Set(found)]
}
