/**
 * Guard: an advisory read hint must never claim bytes saved.
 *
 * `hooks_read.ts` has two shapes of hint. A DENY replaces the read — the file's contents never reach
 * the model, so crediting the (capped) counterfactual is honest. A note returned via
 * `quietContextOutput` does NOT block anything: the Read proceeds, the whole file lands in context
 * anyway, and the note's own text is spent on top of it. Crediting bytes there books a saving on the
 * one path where the product provably spent tokens instead of saving them, and because these paths
 * fire on nearly every re-read they dominated the `session_hint` ledger — the largest single
 * contributor to the headline savings figure.
 *
 * Three separate call sites had this bug and only one was caught by a behavioural test; the other two
 * surfaced only by dogfooding the real binary and reading the ledger. That is the drift this guard
 * exists to stop: the invariant is structural ("advisory ⇒ zero"), so it is checked structurally
 * rather than one example at a time.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..', 'src', 'hooks_read.ts')

/** Each `recordStat('session_hint', ...)` paired with whether the statement it guards returns an advisory note, and the literal arguments it passed. */
function creditSites(): Array<{ line: number; args: string; advisory: boolean }> {
  const lines = readFileSync(SRC, 'utf-8').split(/\r?\n/)
  const out: Array<{ line: number; args: string; advisory: boolean }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = /recordStat\('session_hint',\s*([^)\r\n]*)\)/.exec(lines[i] ?? '')
    if (m === null) continue
    // The returning statement is the next `return` within a short window; a deny and an advisory note are the only two things these branches return.
    let advisory = false
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const l = lines[j] ?? ''
      if (l.includes('return denyOutput')) break
      if (l.includes('return quietContextOutput') || l.includes('return contextOutput')) { advisory = true; break }
    }
    out.push({ line: i + 1, args: (m[1] ?? '').trim(), advisory })
  }
  return out
}

describe('advisory read hints credit no bytes', () => {
  it('every session_hint recorded on a non-blocking path passes 0 bytes and 0 tokens', () => {
    const offenders = creditSites().filter((s) => s.advisory && !/^0\s*,\s*0$/.test(s.args))
    // Name the offender: a bare boolean here would leave the next reader hunting for which of a dozen call sites regressed.
    expect(offenders.map((s) => `hooks_read.ts:${s.line} recordStat('session_hint', ${s.args})`)).toEqual([])
  })

  it('sees both shapes, so a rename cannot make the check vacuously pass', () => {
    const sites = creditSites()
    expect(sites.filter((s) => s.advisory).length).toBeGreaterThanOrEqual(3)
    // Deny sites still credit something -- if this hits zero, the regex stopped matching rather than the code becoming correct.
    expect(sites.filter((s) => !s.advisory && s.args !== '0, 0').length).toBeGreaterThan(0)
  })
})
