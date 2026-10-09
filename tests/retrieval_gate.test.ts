/** The two-sided retrieval gate. Every input is HAND-DERIVED: ranks chosen by hand, and the reciprocal ranks they give worked out from the definition (rank 1 scores 1, rank 5 scores 0.2, null scores 0). */
import { describe, expect, it } from 'vitest'

import { compareToBaseline, toBaseline, type Baseline, type RunRow } from '../evals/retrieval/gate.js'

const rowsAt = (ranks: (number | null)[], kind = 'identifier'): RunRow[] => ranks.map((rank, i) => ({ id: `q${i}`, kind, rank }))
const baseOf = (ranks: (number | null)[], distractors = 150): Baseline => toBaseline({ fused: rowsAt(ranks) }, distractors)

describe('toBaseline', () => {
  it('records answerable queries only, keyed by id', () => {
    const b = toBaseline({ fused: [...rowsAt([1, 3]), { id: 'gone', kind: 'absent', rank: null }] }, 150)
    expect(b.arms['fused']).toEqual({ q0: 1, q1: 3 })
    expect(b.distractors).toBe(150)
  })
})

describe('compareToBaseline', () => {
  const twenty = Array.from({ length: 20 }, () => 5)

  it('passes a run identical to its baseline', () => {
    const r = compareToBaseline({ fused: rowsAt(twenty) }, baseOf(twenty), 150)
    expect(r.failures).toEqual([])
    expect(r.rows[0]?.verdict).toBe('same')
  })

  it('fails when every query falls from rank 1 to rank 5', () => {
    const ones = twenty.map(() => 1)
    const r = compareToBaseline({ fused: rowsAt(twenty) }, baseOf(ones), 150)
    expect(r.rows[0]?.verdict).toBe('regressed')
    expect(r.rows[0]?.delta.mean).toBeCloseTo(-0.8, 10)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('fell by')
  })

  it('also fails when every query rises from rank 5 to rank 1 and the baseline does not say so', () => {
    const ones = twenty.map(() => 1)
    const r = compareToBaseline({ fused: rowsAt(ones) }, baseOf(twenty), 150)
    expect(r.rows[0]?.verdict).toBe('improved')
    expect(r.failures[0]).toContain('does not record it')
  })

  it('lets one query among twenty move without failing', () => {
    const moved = twenty.map((r, i) => (i === 0 ? 1 : r))
    const r = compareToBaseline({ fused: rowsAt(moved) }, baseOf(twenty), 150)
    expect(r.rows[0]?.verdict).toBe('same')
    expect(r.failures).toEqual([])
  })

  it('treats a rank past the cutoff as a miss', () => {
    const r = compareToBaseline({ fused: rowsAt(twenty.map(() => 11)) }, baseOf(twenty.map(() => null)), 150)
    expect(r.rows[0]?.delta.mean).toBe(0)
  })

  it('refuses a comparison that is unsound rather than scoring the overlap', () => {
    expect(compareToBaseline({ fused: rowsAt(twenty) }, baseOf(twenty), 40).failures[0]).toContain('cannot be compared')
    expect(compareToBaseline({}, baseOf(twenty), 150).failures[0]).toContain('did not produce it')
    expect(compareToBaseline({ fused: rowsAt(twenty), extra: rowsAt(twenty) }, baseOf(twenty), 150).failures[0]).toContain('not in the baseline')
    expect(compareToBaseline({ fused: rowsAt(twenty.slice(1)) }, baseOf(twenty), 150).failures[0]).toContain('query set differs')
  })
})
