/** The redaction pass runs over every command output and every cached blob before either reaches the model, so its cost is paid on the hot path. Its patterns looked safe by the usual rule -- no nested or overlapping quantifier, so no single match can backtrack catastrophically -- and the module header said so. That rule misses the case that actually bit: a variable-length lookbehind is re-evaluated at every start position, so an unbounded run inside one makes the whole pass quadratic in the input even though no individual match ever backtracks. `generic_secret_assignment` held `\s*` on both sides of its separator. The input `'password' + ' '.repeat(n) + '=!'` took 108 ms at n=20000 and 1726 ms at n=80000: four times the work for twice the input. Bounding the runs made the same inputs 0.5 ms and 2.2 ms. No stopwatch decides here, because a clock verdict fails on a busy machine and passes on a slow one: the structural checks below are the invariant, and they fail immediately if an unbounded quantifier is ever put back inside a lookbehind, whether written inline or inside a shared constant. The look-back width is also capped, so the work per start position is bounded and the whole pass stays linear in the input. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** Every `.ts` file under src, as a slash path relative to it. */
function listSrcFiles(dir = SRC_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listSrcFiles(full)
    return entry.name.endsWith('.ts') ? [path.relative(SRC_DIR, full).split(path.sep).join('/')] : []
  })
}

/** The text with each line that starts as a comment emptied, since prose naming a lookbehind is no pattern. */
function withoutCommentLines(text: string): string {
  return text.split('\n').map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line)).join('\n')
}

const source = fs.readFileSync(path.join(SRC_DIR, 'secret_redact.ts'), 'utf8')

// A lookbehind this guard cannot clear, keyed `file::body` with the reason it is allowed; none today.
const ALLOWED: ReadonlyMap<string, string> = new Map<string, string>([
  ['change_claim.ts::\\\\b(?:if|whether|when|unless|should|would|could)[ \\\\t]+', 'open, see Follow-ups'],
])

/** Bodies of every `(?<=...)` and `(?<!...)` in the source, brackets balanced. Written by hand rather than with a regex because the thing being scanned for is a regex: a nested-bracket pattern is exactly what a regex reads badly. */
function lookbehindBodies(text: string): string[] {
  const bodies: string[] = []
  for (let start = 0; start < text.length; start += 1) {
    if (!text.startsWith('(?<=', start) && !text.startsWith('(?<!', start)) continue
    let depth = 1
    let inClass = false
    let i = start + 4
    for (; i < text.length && depth > 0; i += 1) {
      const c = text[i]
      if (c === String.fromCharCode(92)) {
        i += 1
        continue
      }
      if (inClass) {
        if (c === ']') inClass = false
        continue
      }
      if (c === '[') inClass = true
      else if (c === '(') depth += 1
      else if (c === ')') depth -= 1
    }
    bodies.push(text.slice(start + 4, i - 1))
  }
  return bodies
}

/** Quantifiers with no upper bound, ignoring any inside a character class or escaped. */
function unboundedQuantifiers(body: string): string[] {
  const found: string[] = []
  let inClass = false
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (c === String.fromCharCode(92)) {
      i += 1
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '*' || c === '+') found.push(c)
    else if (c === '{') {
      const close = body.indexOf('}', i)
      const spec = close === -1 ? '' : body.slice(i + 1, close)
      if (/^\d+,$/.test(spec)) found.push(`{${spec}}`)
    }
  }
  return found
}

/** Each `const NAME = String.raw` declaration (pieces joined by `+`, maybe an arrow head) as name -> text. */
function templateConstants(text: string): Map<string, string> {
  const constants = new Map<string, string>()
  const head = /const (\w+)(?::[^=\n]+)? =\s*(?:\([^)]*\)(?:: \w+)? =>\s*)?/.source
  const declaration = new RegExp(`${head}((?:String\\.raw\`[^\`]*\`\\s*\\+?\\s*)+)`, 'g')
  for (const m of text.matchAll(declaration)) {
    const pieces = [...(m[2] ?? '').matchAll(/String\.raw`([^`]*)`/g)]
    constants.set(m[1] ?? '', pieces.map((x) => x[1] ?? '').join(''))
  }
  return constants
}

/** A lookbehind body with its `${NAME}` references replaced; `${quote}` forks in both quotes, unknown stays. */
function expandTemplates(body: string, constants: ReadonlyMap<string, string>, depth = 0): string[] {
  const from = (text: string, pos: number): string[] => {
    const m = /\$\{(\w+)\}/.exec(text.slice(pos))
    if (!m) return [text]
    const at = pos + m.index
    const known = depth < 20 ? (m[1] === 'quote' ? ['"', "'"] : [constants.get(m[1] ?? '')]) : [undefined]
    return known.flatMap((value) =>
      value === undefined
        ? from(text, at + m[0].length)
        : expandTemplates(text.slice(0, at) + value + text.slice(at + m[0].length), constants, depth + 1),
    )
  }
  return from(body, 0)
}

// limit: a lookbehind wider than this fails revisit-when: a legitimate pattern needs a longer look back
const MAX_LOOKBEHIND_WIDTH = 256

/** The most characters a pattern can consume, `Infinity` if unbounded; reads groups, classes, `{n,m}`. */
function maxWidth(pattern: string): number {
  const bs = String.fromCharCode(92)
  let pos = 0
  const atom = (): number => {
    const c = pattern[pos]
    if (c === '(') {
      const zeroWidth = /^\(\?<?[=!]/.exec(pattern.slice(pos))
      pos += zeroWidth ? zeroWidth[0].length : pattern.startsWith('(?:', pos) ? 3 : 1
      const inner = alternation()
      pos += 1
      return zeroWidth ? 0 : inner
    }
    if (c === '[') {
      pos += 1
      while (pos < pattern.length && pattern[pos] !== ']') pos += pattern[pos] === bs ? 2 : 1
      pos += 1
      return 1
    }
    if (c === bs) {
      pos += 2
      return pattern[pos - 1] === 'b' || pattern[pos - 1] === 'B' ? 0 : 1
    }
    pos += 1
    return c === '^' || c === '$' ? 0 : 1
  }
  const quantified = (): number => {
    const width = atom()
    const c = pattern[pos]
    let times = 1
    let quantifier = false
    if (c === '*' || c === '+') {
      pos += 1
      times = Infinity
      quantifier = true
    } else if (c === '?') {
      pos += 1
      quantifier = true
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(pos))
      if (m) {
        pos += m[0].length
        times = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3])
        quantifier = true
      }
    }
    if (quantifier && pattern[pos] === '?') pos += 1
    return width === 0 ? 0 : width * times
  }
  const sequence = (): number => {
    let total = 0
    while (pos < pattern.length && pattern[pos] !== '|' && pattern[pos] !== ')') total += quantified()
    return total
  }
  const alternation = (): number => {
    let best = sequence()
    while (pattern[pos] === '|') {
      pos += 1
      best = Math.max(best, sequence())
    }
    return best
  }
  return alternation()
}

describe('lookbehind quantifiers stay bounded', () => {
  // Every lookbehind in a literal, a String.raw constant or a `new RegExp(` string, in every src file.
  const scanned = pinnedPopulation({
    what: 'src/**/*.ts files scanned for lookbehinds',
    items: listSrcFiles(),
    floor: 400,
    mustInclude: ['secret_redact.ts', 'change_claim.ts'],
  })
  const allSites = scanned.flatMap((file) => {
    const text = withoutCommentLines(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'))
    const constants = templateConstants(text)
    return lookbehindBodies(text).map((body) => ({ file, body, constants, key: `${file}::${body}` }))
  })
  const sites = allSites.filter((s) => !ALLOWED.has(s.key))
  const bodies = sites.map((s) => s.body)
  const label = (s: { file: string; body: string }, text = s.body): string => `${s.file}: (?<=${text})`

  it('finds the lookbehinds at all, so an empty sweep cannot pass as a clean one', () => {
    expect(lookbehindBodies(source).length).toBeGreaterThanOrEqual(4)
    expect(allSites.filter((s) => s.file === 'secret_redact.ts').length).toBeGreaterThanOrEqual(4)
    expect(new Set(allSites.map((s) => s.file)).size).toBeGreaterThanOrEqual(10)
  })

  it('names no allowlist entry that no longer matches a lookbehind', () => {
    const keys = new Set(allSites.map((s) => s.key))
    expect([...ALLOWED.keys()].filter((k) => !keys.has(k))).toEqual([])
  })

  it('sees a lookbehind written as a plain string for new RegExp, and one inside a regex literal', () => {
    expect(lookbehindBodies("new RegExp('(?<=a\\\\s*)b')")).toEqual(['a\\\\s*'])
    expect(unboundedQuantifiers('a\\\\s*')).toEqual(['*'])
    expect(lookbehindBodies('const r = /(?<!x{1,4})y/')).toEqual(['x{1,4}'])
  })

  it('reads a nested-bracket lookbehind without stopping at the first bracket', () => {
    expect(lookbehindBodies('/(?<=a[)(]b)x/')).toEqual(['a[)(]b'])
  })

  it('tells an unbounded quantifier from a bounded one', () => {
    const bs = String.fromCharCode(92)

    // The backslash consumes the `s`, so the `*` after it is still a real quantifier...
    expect(unboundedQuantifiers(`a${bs}s*b`)).toEqual(['*'])
    // ...while an escaped star is a literal and must not be counted as one.
    expect(unboundedQuantifiers(`a${bs}*b`)).toEqual([])
    expect(unboundedQuantifiers('a{0,8}b{2,}')).toEqual(['{2,}'])
    expect(unboundedQuantifiers('[a*+]{0,8}')).toEqual([])
  })

  it('has no unbounded quantifier inside any lookbehind', () => {
    const offenders = sites
      .map((s) => ({ s, quantifiers: unboundedQuantifiers(s.body) }))
      .filter((o) => o.quantifiers.length > 0)
      .map((o) => `${o.quantifiers.join(' ')} in ${label(o.s)}`)

    expect(offenders, 'each of these makes the whole pass quadratic in input size').toEqual([])
  })

  // Lookbehinds are partly spelled through shared constants, so read them with those substituted in.
  it('has no unbounded quantifier in any lookbehind once the shared constants are substituted in', () => {
    const expanded = sites.flatMap((s) => expandTemplates(s.body, s.constants).map((text) => ({ s, text })))

    expect(expanded.length).toBeGreaterThanOrEqual(bodies.length)
    const unresolved = expanded.filter((e) => e.text.includes('${')).map((e) => label(e.s, e.text))
    expect(unresolved, 'a source the expansion could not resolve: allowlist it with a reason').toEqual([])
    const offenders = expanded
      .map((e) => ({ e, quantifiers: unboundedQuantifiers(e.text) }))
      .filter((o) => o.quantifiers.length > 0)
      .map((o) => `${o.quantifiers.join(' ')} in ${label(o.e.s, o.e.text)}`)

    expect(offenders, 'each of these makes the whole pass quadratic in input size').toEqual([])
  })

  it('reads an unbounded run through a constant, and forks on the quote placeholder', () => {
    const synthetic = [
      'const GAP = String.raw`x*`',
      'const KEY = String.raw`k${GAP}`',
      'const sep = (quote: string): string =>',
      '  String.raw`(?<=${KEY}${quote})v`',
    ].join('\n')
    const constants = templateConstants(synthetic)
    const expanded = lookbehindBodies(synthetic).flatMap((b) => expandTemplates(b, constants))

    expect(expanded).toEqual(['kx*"', "kx*'"])
    expect(expanded.flatMap(unboundedQuantifiers)).toEqual(['*', '*'])
  })

  it('has a bounded width in every expanded lookbehind, so the work per start position is capped', () => {
    const widths = sites
      .flatMap((s) => expandTemplates(s.body, s.constants).map((text) => ({ s, text })))
      .map((e) => ({ at: label(e.s, e.text), width: maxWidth(e.text) }))

    expect(widths.filter((w) => !Number.isFinite(w.width) || w.width > MAX_LOOKBEHIND_WIDTH)).toEqual([])
    expect(maxWidth('a{0,8}[bc]{1,3}(?:x|yz)\\s')).toBe(8 + 3 + 2 + 1)
    expect(maxWidth('a+')).toBe(Infinity)
  })
})
