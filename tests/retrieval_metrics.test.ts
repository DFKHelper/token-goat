/** `evals/retrieval/metrics.ts` is the arithmetic behind the retrieval evals: which hit counts as the labelled answer, hit@k, MRR, the bootstrap intervals and the train/test split. Provenance: ranks, reciprocal ranks, overlaps, means and bytes-per-hit below are HAND-DERIVED: each expected value is worked from the input on paper, not read off the implementation. The FNV-1a values are FORMAT-DERIVED from the published FNV test vectors (Fowler/Noll/Vo, `fnv1a32` of "", "a" and "foobar": 0x811c9dc5, 0xe40c292c, 0xbf9cf968). The path spellings are CAPTURE: `search -j` reported `c:/Projects/token-goat/src/worker.ts` and `semantic -j` reported `tests/reconcile_parser_stale.test.ts` for the same repository on 2026-09-29. */
import { describe, expect, it } from 'vitest'

import {
  bootstrapCI,
  bytesPerCorrectHit,
  correctInTopK,
  firstRelevantRank,
  fnv1a,
  hitAtK,
  hubFiles,
  hitMatches,
  mean,
  mulberry32,
  normalizePath,
  pairedBootstrapDelta,
  percentile,
  reciprocalRank,
  splitOf,
  top1CollisionRate,
} from '../evals/retrieval/metrics.js'

const ROOT = 'C:\\Projects\\token-goat'

describe('normalizePath', () => {
  it('brings search and semantic spellings of one file to the same key', () => {
    expect(normalizePath('c:/Projects/token-goat/src/worker.ts', ROOT)).toBe('src/worker.ts')
    expect(normalizePath('src\\worker.ts', ROOT)).toBe('src/worker.ts')
    expect(normalizePath('./src/worker.ts', ROOT)).toBe('src/worker.ts')
    expect(normalizePath('C:/Projects/token-goat/src/Worker.ts', 'c:/projects/token-goat/')).toBe('src/worker.ts')
  })

  it('leaves a path outside the root absolute rather than stripping a prefix that only looks like the root', () => {
    // token-goat-wt-latency starts with the root's characters but is a sibling worktree, not a child.
    expect(normalizePath('c:/Projects/token-goat-wt-latency/src/worker.ts', ROOT)).toBe('c:/projects/token-goat-wt-latency/src/worker.ts')
  })
})

describe('hitMatches', () => {
  const span = { file: 'src/worker.ts', lineStart: 10, lineEnd: 20 }

  it('counts an overlapping span, including one that only touches an end line', () => {
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 15, lineEnd: 16 }, span)).toBe(true)
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 20, lineEnd: 30 }, span)).toBe(true)
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 1, lineEnd: 10 }, span)).toBe(true)
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 1, lineEnd: 100 }, span)).toBe(true)
  })

  it('rejects a disjoint span in the right file', () => {
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 21, lineEnd: 30 }, span)).toBe(false)
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 1, lineEnd: 9 }, span)).toBe(false)
  })

  it('rejects a file-level hit against a span label, but accepts it against a file label', () => {
    expect(hitMatches({ file: 'src/worker.ts' }, span)).toBe(false)
    expect(hitMatches({ file: 'src/worker.ts' }, { file: 'src/worker.ts' })).toBe(true)
    expect(hitMatches({ file: 'src/worker.ts', lineStart: 400, lineEnd: 410 }, { file: 'src/worker.ts' })).toBe(true)
  })

  it('rejects the right lines in the wrong file', () => {
    expect(hitMatches({ file: 'src/parser.ts', lineStart: 10, lineEnd: 20 }, span)).toBe(false)
  })

  it('compares through the root', () => {
    expect(hitMatches({ file: 'c:/Projects/token-goat/src/worker.ts', lineStart: 12, lineEnd: 12 }, span, ROOT)).toBe(true)
  })
})

describe('rank metrics', () => {
  const relevant = [{ file: 'a.ts', lineStart: 5, lineEnd: 8 }, { file: 'b.ts' }]
  const hits = [
    { file: 'x.ts' },
    { file: 'a.ts', lineStart: 50, lineEnd: 60 },
    { file: 'a.ts', lineStart: 7, lineEnd: 7 },
    { file: 'y.ts' },
    { file: 'b.ts', lineStart: 1, lineEnd: 3 },
  ]

  it('finds the 1-based rank of the first matching hit', () => {
    expect(firstRelevantRank(hits, relevant)).toBe(3)
    expect(firstRelevantRank([{ file: 'x.ts' }], relevant)).toBeNull()
    expect(firstRelevantRank([], relevant)).toBeNull()
  })

  it('counts correct hits inside the cutoff only', () => {
    expect(correctInTopK(hits, relevant, 10)).toBe(2)
    expect(correctInTopK(hits, relevant, 4)).toBe(1)
    expect(correctInTopK(hits, relevant, 2)).toBe(0)
  })

  it('scores hit@k and reciprocal rank at the cutoff boundary', () => {
    expect(hitAtK(3, 3)).toBe(1)
    expect(hitAtK(4, 3)).toBe(0)
    expect(hitAtK(null, 10)).toBe(0)
    expect(reciprocalRank(1, 10)).toBe(1)
    expect(reciprocalRank(4, 10)).toBe(0.25)
    expect(reciprocalRank(11, 10)).toBe(0)
    expect(reciprocalRank(null, 10)).toBe(0)
  })

  it('averages to MRR over a query set', () => {
    // Ranks 1, 2, none, 4 -> (1 + 0.5 + 0 + 0.25) / 4 = 0.4375.
    expect(mean([1, 2, null, 4].map((r) => reciprocalRank(r, 10)))).toBe(0.4375)
    expect(mean([])).toBeNaN()
  })
})

describe('bytesPerCorrectHit', () => {
  it('divides bytes by correct hits and refuses to price zero hits', () => {
    expect(bytesPerCorrectHit(3000, 2)).toBe(1500)
    expect(bytesPerCorrectHit(3000, 0)).toBeNull()
  })
})

describe('bootstrap', () => {
  it('is reproducible for a seed and stays in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const xs = Array.from({ length: 1000 }, () => a())
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(new Set(xs).size).toBeGreaterThan(990)
  })

  it('passes the seed to the resampler', () => {
    // Twenty resamples of ten values leave room for two seeds to disagree about the extremes; if the seed never reached mulberry32, every seed would give the first one's interval.
    const xs = [0, 1, 0, 0, 1, 1, 0, 1, 0, 0]
    const one = bootstrapCI(xs, { seed: 1, iterations: 20 })
    expect(bootstrapCI(xs, { seed: 1, iterations: 20 })).toEqual(one)
    expect(bootstrapCI(xs, { seed: 2, iterations: 20 })).not.toEqual(one)
  })

  it('reads a percentile at index floor(q * n), clamped to the ends', () => {
    const sorted = [10, 20, 30, 40]
    expect(percentile(sorted, 0)).toBe(10)
    expect(percentile(sorted, 0.3)).toBe(20) // floor(1.2) = 1
    expect(percentile(sorted, 0.5)).toBe(30) // floor(2) = 2
    expect(percentile(sorted, 0.99)).toBe(40) // floor(3.96) = 3
    expect(percentile(sorted, 1)).toBe(40) // index 4 clamps to 3
    expect(percentile([], 0.5)).toBeNaN()
  })

  it('gives a zero-width interval for constant data', () => {
    expect(bootstrapCI([1, 1, 1, 1])).toEqual({ mean: 1, lo: 1, hi: 1 })
  })

  it('spans the whole range for two points', () => {
    // Resampled means of [0, 1] are 0, 0.5 or 1 with probability 1/4, 1/2, 1/4, so both 2.5% tails sit on an endpoint.
    const ci = bootstrapCI([0, 1], { seed: 7 })
    expect(ci).toEqual({ mean: 0.5, lo: 0, hi: 1 })
  })

  it('brackets the mean and narrows as the sample grows', () => {
    const small = bootstrapCI([0, 1, 0, 1, 1, 0, 1, 0])
    const large = bootstrapCI(Array.from({ length: 400 }, (_, i) => i % 2))
    expect(small.lo).toBeLessThanOrEqual(small.mean)
    expect(small.hi).toBeGreaterThanOrEqual(small.mean)
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo)
  })

  it('splits alpha across both tails', () => {
    // 100 alternating 0/1 values: the mean's standard error is 0.05, so a 50% interval is about 0.5 +/- 0.674 * 0.05 = [0.466, 0.534]. Putting all of alpha in one tail would land that bound on the median, 0.5.
    const ci = bootstrapCI(Array.from({ length: 100 }, (_, i) => i % 2), { alpha: 0.5 })
    expect(ci.lo).toBeGreaterThan(0.44)
    expect(ci.lo).toBeLessThan(0.49)
    expect(ci.hi).toBeGreaterThan(0.51)
    expect(ci.hi).toBeLessThan(0.56)
  })

  it('pairs the two arms query by query', () => {
    expect(pairedBootstrapDelta([0, 0, 0], [1, 1, 1])).toEqual({ mean: 1, lo: 1, hi: 1 })
    // Unpaired, these arms have the same mean. Paired, every query moved by exactly +0.5, so the interval is a point.
    expect(pairedBootstrapDelta([0, 1, 0.5], [0.5, 1.5, 1])).toEqual({ mean: 0.5, lo: 0.5, hi: 0.5 })
  })

  it('refuses arms of different length', () => {
    expect(() => pairedBootstrapDelta([1, 2], [1])).toThrow(/differ in length/)
  })
})

describe('split', () => {
  it('matches the published FNV-1a vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  it('assigns an id the same way every time, and honours the extremes', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `q${i}`)
    expect(ids.map((id) => splitOf(id))).toEqual(ids.map((id) => splitOf(id)))
    expect(ids.every((id) => splitOf(id, 0) === 'train')).toBe(true)
    expect(ids.every((id) => splitOf(id, 1) === 'test')).toBe(true)
  })

  it('holds out roughly the requested fraction', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `query-${i}`)
    const test = ids.filter((id) => splitOf(id, 0.3) === 'test').length
    expect(test).toBeGreaterThan(500)
    expect(test).toBeLessThan(700)
  })
})

describe('hubFiles', () => {
  it('counts a file once per query and keeps those at or above the share', () => {
    // Four queries: a appears in three (3/4), b in two (the repeat inside the third query counts once, 2/4), c and d in one each (1/4).
    const tops = [['a', 'b'], ['a', 'c'], ['a', 'b', 'b'], ['d']]
    expect(hubFiles(tops, 0.5)).toEqual([
      { file: 'a', share: 0.75 },
      { file: 'b', share: 0.5 },
    ])
    expect(hubFiles(tops, 0.25).map((h) => h.file)).toEqual(['a', 'b', 'c', 'd'])
    expect(hubFiles([], 0.1)).toEqual([])
  })
})

describe('top1CollisionRate', () => {
  it('counts every member of a shared first hit once one of them is labelled elsewhere', () => {
    // Five queries answered (the null one is not). x is first for two queries and one is labelled y: both collide. z is first for two that are both labelled z: agreement, not a collision. w is first for one query alone: wrong, but nothing collides with it. 2 / 5 = 0.4.
    const rows = [
      { top1: 'x', labelFiles: ['x'] },
      { top1: 'x', labelFiles: ['y'] },
      { top1: 'z', labelFiles: ['z'] },
      { top1: 'z', labelFiles: ['z'] },
      { top1: 'w', labelFiles: ['q'] },
      { top1: null, labelFiles: ['x'] },
    ]
    expect(top1CollisionRate(rows)).toBe(0.4)
    expect(top1CollisionRate([{ top1: null, labelFiles: [] }])).toBeNull()
  })
})
