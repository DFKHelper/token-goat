/** The retrieval eval's abstention parsing and quality report. The `semantic --json` samples are FORMAT-DERIVED from the payload src/read_semantic.ts builds (`items[].filePath/startLine/endLine/distance`, with `distance` null on a keyword-only row, and `lowConfidence: {closestDistance, threshold}` set only when the closest dense match is past the weak line). Every expected rate and line in the quality report is HAND-DERIVED from the rows written here. */
import { describe, expect, it } from 'vitest'

import { qualityLines, weakFitLines } from '../evals/retrieval/quality.js'
import { parseSemantic } from '../scripts/eval-retrieval.js'

const item = (filePath: string, distance: number | null) => ({ filePath, name: null, kind: null, startLine: 1, endLine: 2, rank: 1, rrf: 0.01, retrieval: distance === null ? 'lexical' : 'dense', distance, preview: '' })

describe('parseSemantic', () => {
  it('answers with the closest dense distance among its results, ignoring keyword-only rows', () => {
    const p = parseSemantic(JSON.stringify({ source: 'embeddings', items: [item('a.ts', 0.71), item('b.ts', null), item('c.ts', 0.64)], truncated: false, totalCount: 3 }))
    expect(p.closest).toBe(0.64)
    expect(p.abstained).toBe(false)
    expect(p.hits.map((h) => h.file)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('abstains when the weak-match flag is set and takes the distance from it', () => {
    const p = parseSemantic(JSON.stringify({ source: 'embeddings', items: [item('a.ts', 0.91)], truncated: false, totalCount: 1, lowConfidence: { closestDistance: 0.9, threshold: 0.85 } }))
    expect(p.closest).toBe(0.9)
    expect(p.abstained).toBe(true)
  })

  it('abstains with no distance when nothing dense came back', () => {
    expect(parseSemantic(JSON.stringify({ source: 'embeddings', items: [item('a.ts', null)], truncated: false, totalCount: 1 }))).toMatchObject({ closest: null, abstained: true })
    expect(parseSemantic(JSON.stringify({ source: 'embeddings', items: [], truncated: false, totalCount: 0 }))).toMatchObject({ closest: null, abstained: true, hits: [] })
  })
})

describe('qualityLines', () => {
  it('reports abstention per class, top-1 collisions on answerable queries and hub files over all of them', () => {
    // Absent: one of two abstains (50%). Answerable: none of two abstain (0%). Answerable top-1s are x.ts for both, labelled a.ts and b.ts, so both collide (100%). x.ts is in the top results of 3 of 4 queries (75%); a.ts and y.ts are in 1 each (25%, at the line), tied and listed by name.
    const rows = [
      { absent: true, abstained: true, topFiles: [], labelFiles: [] },
      { absent: true, abstained: false, topFiles: ['x.ts'], labelFiles: [] },
      { absent: false, abstained: false, topFiles: ['x.ts', 'a.ts'], labelFiles: ['a.ts'] },
      { absent: false, abstained: false, topFiles: ['x.ts', 'y.ts'], labelFiles: ['b.ts'] },
    ]
    const [abstain, collision, hubs] = qualityLines(rows, '  ')
    expect(abstain).toMatch(/^ {2}abstains on absent 50\.0 .* \(n=2\), on answerable 0\.0 .* \(n=2\)$/)
    expect(collision).toBe('  top-1 collision 100% of answered answerable queries')
    expect(hubs).toBe('  hubs (top results of >= 25% of queries): x.ts 75%, a.ts 25%, y.ts 25%')
  })

  it('leaves absent queries out of the collision rate, since they have no right first answer to miss', () => {
    // Answerable top-1s are x.ts (wrong) and b.ts (right), one each: no file is shared, 0%. Counting the absent query's x.ts would make x.ts shared and wrong, 2 of 3.
    const rows = [
      { absent: true, abstained: false, topFiles: ['x.ts'], labelFiles: [] },
      { absent: false, abstained: false, topFiles: ['x.ts'], labelFiles: ['a.ts'] },
      { absent: false, abstained: false, topFiles: ['b.ts'], labelFiles: ['b.ts'] },
    ]
    expect(qualityLines(rows, '')[1]).toBe('top-1 collision 0% of answered answerable queries')
  })

  it('prints a dash where a class is missing', () => {
    const [abstain, collision] = qualityLines([{ absent: true, abstained: true, topFiles: [], labelFiles: [] }], '')
    expect(abstain).toBe('abstains on absent 100.0 [100.0, 100.0] (n=1), on answerable - (n=0)')
    expect(collision).toBe('top-1 collision - of answered answerable queries')
  })
})

describe('weakFitLines', () => {
  it('scores the configured and the train-fitted line on the test split', () => {
    // Train separates at 0.75, scoring 0 there. On test, 0.85 lets both absent queries through (miss 2/2) and keeps 0.6 (no alarm): 0.500. 0.75 catches 0.8 but not 0.7 (miss 1/2) and keeps 0.6: 0.250, so the test score differs from the train one.
    const train = [
      { absent: false, closest: 0.5 },
      { absent: false, closest: 0.6 },
      { absent: true, closest: 0.9 },
      { absent: true, closest: 1.0 },
    ]
    const test = [
      { absent: false, closest: 0.6 },
      { absent: true, closest: 0.8 },
      { absent: true, closest: 0.7 },
    ]
    expect(weakFitLines(train, test, 0.85, '')).toEqual([
      'weak_distance 0.850 (configured) on test: balanced error 0.500 (abstains on absent 0%, on answerable 0%)',
      'weak_distance 0.750 (fitted on train, balanced error 0.000 (abstains on absent 100%, on answerable 0%)) on test: balanced error 0.250 (abstains on absent 50%, on answerable 0%)',
    ])
  })

  it('says what it needs when the train split cannot be fitted', () => {
    expect(weakFitLines([{ absent: true, closest: 0.9 }], [], 0.85, '')).toEqual(['weak_distance fit: needs absent and answerable queries with a distance in the train split'])
  })
})
