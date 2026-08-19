/**
 * The redaction pass runs over every command output and every cached blob before either reaches
 * the model, so its cost is paid on the hot path. Its patterns looked safe by the usual rule --
 * no nested or overlapping quantifier, so no single match can backtrack catastrophically -- and
 * the module header said so. That rule misses the case that actually bit: a variable-length
 * lookbehind is re-evaluated at every start position, so an unbounded run inside one makes the
 * whole pass quadratic in the input even though no individual match ever backtracks.
 *
 * `generic_secret_assignment` held `\s*` on both sides of its separator. The input
 * `'password' + ' '.repeat(n) + '=!'` took 108 ms at n=20000 and 1726 ms at n=80000: four times
 * the work for twice the input. Bounding the runs made the same inputs 0.5 ms and 2.2 ms.
 *
 * The timing assertion below is the symptom and is deliberately loose. This structural check is
 * the invariant, and it is what fails immediately and without a stopwatch if an unbounded
 * quantifier is ever put back inside a lookbehind.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { redactSecrets } from '../../src/secret_redact.js'

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'secret_redact.ts'),
  'utf8',
)

/**
 * Bodies of every `(?<=...)` and `(?<!...)` in the source, brackets balanced. Written by hand
 * rather than with a regex because the thing being scanned for is a regex: a nested-bracket
 * pattern is exactly what a regex reads badly.
 */
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

describe('lookbehind quantifiers stay bounded', () => {
  const bodies = lookbehindBodies(source)

  it('finds the lookbehinds at all, so an empty sweep cannot pass as a clean one', () => {
    expect(bodies.length).toBeGreaterThanOrEqual(4)
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
    const offenders = bodies
      .map((b) => ({ body: b, quantifiers: unboundedQuantifiers(b) }))
      .filter((o) => o.quantifiers.length > 0)
      .map((o) => `${o.quantifiers.join(' ')} in (?<=${o.body})`)

    expect(offenders, 'each of these makes the whole pass quadratic in input size').toEqual([])
  })

  // The symptom the invariant above exists to prevent. The budget is ~400x the measured cost and
  // ~5x below the pre-fix cost, so it is not a benchmark and should not flake on a loaded machine.
  it('stays fast on a long whitespace run after a keyword', () => {
    const input = `password${' '.repeat(80_000)}=!`

    const started = performance.now()
    expect(redactSecrets(input).count).toBe(0)

    expect(performance.now() - started).toBeLessThan(400)
  })
})
