import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every figure published in `demo/evidence/12-eval-paired.txt` (and therefore in
 * `demo/fixtures/token-goat-eval.pdf`, which is rendered from it) is recomputed
 * here from `demo/data/eval-runs.csv` — the same rows a skeptic downloads.
 *
 * This is deliberately a second, independent implementation of the arithmetic in
 * `scripts/generate-eval-capture.py`, not a call into it. Two implementations
 * agreeing is evidence; one implementation agreeing with itself is not. A test
 * that regenerated the capture by running the generator would pass for any
 * generator, including a wrong one.
 */

const ROOT = path.join(__dirname, '..')
const CAPTURE = readFileSync(path.join(ROOT, 'demo', 'evidence', '12-eval-paired.txt'), 'utf8')
const CSV = readFileSync(path.join(ROOT, 'demo', 'data', 'eval-runs.csv'), 'utf8')

// Duplicated from the generator on purpose: if someone changes the exclusion set
// or the billing weights on one side only, these tests must go red.
const CONTAMINATED = new Set(['c7345de33a71', '5d3c55d0fa73'])
const WEIGHTS = { fresh: 1.0, cacheWrite: 1.25, cacheRead: 0.1 }

interface Run {
  sha: string
  arm: string
  status: string
  fresh: number
  cacheWrite: number
  cacheRead: number
  turns: number
  resolved: number
}

/**
 * RFC 4180 field split. `arm_tool_names` is a quoted JSON array, so it carries
 * both commas and doubled quotes — splitting on `,` misaligns every column after
 * it, which is silent rather than loud. Row width is asserted below to catch a
 * parse that goes wrong anyway.
 */
function splitRow(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quoted) {
      if (ch !== '"') field += ch
      else if (line[i + 1] === '"') {
        field += '"'
        i += 1
      } else quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      fields.push(field)
      field = ''
    } else field += ch
  }
  fields.push(field)
  expect(quoted, `unterminated quote in: ${line.slice(0, 60)}`).toBe(false)
  return fields
}

function parseCsv(text: string): Run[] {
  const [header, ...lines] = text.trim().split('\n')
  const cols = splitRow(header!)
  const at = (row: string[], name: string): string => row[cols.indexOf(name)] ?? ''
  return lines.map((line) => {
    const row = splitRow(line)
    expect(row.length).toBe(cols.length)
    return {
      sha: at(row, 'sha'),
      arm: at(row, 'arm'),
      status: at(row, 'status'),
      fresh: Number(at(row, 'input_tokens') || 0),
      cacheWrite: Number(at(row, 'cache_creation_tokens') || 0),
      cacheRead: Number(at(row, 'cache_read_tokens') || 0),
      turns: Number(at(row, 'turns_used') || 0),
      resolved: Number(at(row, 'resolved') || 0),
    }
  })
}

const weighted = (r: Run): number =>
  WEIGHTS.fresh * r.fresh + WEIGHTS.cacheWrite * r.cacheWrite + WEIGHTS.cacheRead * r.cacheRead
const total = (r: Run): number => r.fresh + r.cacheWrite + r.cacheRead
const context = (r: Run): number => r.fresh + r.cacheWrite

function median(values: number[]): number {
  expect(values.length).toBeGreaterThan(0)
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const runs = parseCsv(CSV)
const pairs = new Map<string, { A?: Run; B?: Run }>()
for (const run of runs) {
  if (run.status !== 'ok') continue
  const entry = pairs.get(run.sha) ?? {}
  entry[run.arm as 'A' | 'B'] = run
  pairs.set(run.sha, entry)
}
const complete = [...pairs.entries()]
  .filter(([, arms]) => arms.A && arms.B)
  .map(([sha, arms]) => ({ sha, a: arms.A!, b: arms.B! }))
  .sort((x, y) => x.sha.localeCompare(y.sha))
const clean = complete.filter((p) => !CONTAMINATED.has(p.sha.slice(0, 12)))

describe('published eval capture matches the vendored data', () => {
  it('has a non-empty population to check', () => {
    // A guard whose population silently empties passes vacuously. This repo has
    // shipped that defect before, so the floors are asserted, not assumed.
    expect(runs.length).toBeGreaterThan(20)
    expect(complete.length).toBeGreaterThanOrEqual(8)
    expect(clean.length).toBeGreaterThanOrEqual(6)
    expect(clean.length).toBeLessThan(complete.length)
  })

  it('states the pair counts the data supports', () => {
    expect(CAPTURE).toContain(`clean (n=${clean.length})`)
    expect(CAPTURE).toContain(`all (n=${complete.length})`)
    expect(CAPTURE).toContain(`n = ${clean.length} clean pairs`)
  })

  it('reproduces every per-pair row', () => {
    for (const { sha, a, b } of complete) {
      const short = sha.slice(0, 12)
      const row = CAPTURE.split('\n').find((line) => line.trim().startsWith(short))
      expect(row, `no published row for ${short}`).toBeTruthy()
      const cells = row!.trim().split(/\s+/)
      // task, turnsA, turnsB, armA, armB, ratio[, "excluded"]
      expect(Number(cells[1])).toBe(a.turns)
      expect(Number(cells[2])).toBe(b.turns)
      expect(Number(cells[3]!.replace(/,/g, ''))).toBe(Math.round(weighted(a)))
      expect(Number(cells[4]!.replace(/,/g, ''))).toBe(Math.round(weighted(b)))
      expect(Number(cells[5])).toBeCloseTo(weighted(b) / weighted(a), 3)
      expect(row!.includes('excluded')).toBe(CONTAMINATED.has(short))
    }
  })

  it('reproduces each median, on both the clean and the full set', () => {
    const measures: [string, (r: Run) => number][] = [
      ['total input (cache hits included)', total],
      ['fresh context (input + cache write)', context],
      ['billing-weighted', weighted],
    ]
    for (const [label, measure] of measures) {
      const row = CAPTURE.split('\n').find((line) => line.trim().startsWith(label))
      expect(row, `no published median row for ${label}`).toBeTruthy()
      const [publishedClean, publishedAll] = row!.trim().slice(label.length).trim().split(/\s+/)
      expect(Number(publishedClean)).toBeCloseTo(
        median(clean.map((p) => measure(p.b) / measure(p.a))),
        3,
      )
      expect(Number(publishedAll)).toBeCloseTo(
        median(complete.map((p) => measure(p.b) / measure(p.a))),
        3,
      )
    }
  })

  it('reproduces the headline saving and does not overstate it', () => {
    const cleanMedian = median(clean.map((p) => weighted(p.b) / weighted(p.a)))
    const allMedian = median(complete.map((p) => weighted(p.b) / weighted(p.a)))
    expect(CAPTURE).toContain(
      `clean billing-weighted saving: ${(100 * (1 - cleanMedian)).toFixed(1)}%`,
    )
    expect(CAPTURE).toContain(`all   billing-weighted saving: ${(100 * (1 - allMedian)).toFixed(1)}%`)
    // The full-sample figure is the less flattering one; publishing only the
    // clean number would be the easy way to overstate the result.
    expect(allMedian).toBeGreaterThan(cleanMedian)
  })

  it('discloses the spread and every pair where token-goat cost more', () => {
    const ratios = clean.map((p) => weighted(p.b) / weighted(p.a)).sort((a, b) => a - b)
    expect(CAPTURE).toContain(ratios.map((r) => r.toFixed(3)).join(', '))
    const worse = ratios.filter((r) => r > 1).length
    expect(CAPTURE).toContain(`pairs where arm B cost MORE : ${worse} of ${clean.length}`)
    // A published result claiming zero adverse pairs while the data holds one is
    // the specific dishonesty this assertion exists to prevent.
    expect(worse).toBeGreaterThan(0)
  })

  it('discloses the discarded runs rather than only the surviving ones', () => {
    const voids = runs.filter((r) => r.status === 'void')
    expect(voids.length).toBeGreaterThan(0)
    expect(CAPTURE).toContain(`void runs : ${voids.length} of ${runs.length} recorded`)
    expect(CAPTURE).toContain(`arm A     : ${voids.filter((r) => r.arm === 'A').length}`)
    expect(CAPTURE).toContain(`arm B     : ${voids.filter((r) => r.arm === 'B').length}`)
  })

  it('claims no outcome difference, because the data shows none', () => {
    const concordant = complete.filter((p) => p.a.resolved === 1 && p.b.resolved === 1).length
    expect(concordant).toBe(complete.length)
    expect(CAPTURE).toContain(`${concordant}/${complete.length} pairs resolved in BOTH arms`)
    expect(CAPTURE).toContain('cost')
    expect(CAPTURE).toContain('says nothing about capability or quality')
  })
})
