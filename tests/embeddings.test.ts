import { describe, it, expect } from 'vitest'
import * as embeddings from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'

describe('embeddings module', () => {
  describe('isAvailable()', () => {
    it('should return a boolean', () => {
      const result = embeddings.isAvailable()
      expect(typeof result).toBe('boolean')
    })

    it('should be consistent across multiple calls', () => {
      const first = embeddings.isAvailable()
      const second = embeddings.isAvailable()
      expect(first).toBe(second)
    })
  })

  describe('packVec()', () => {
    it('should pack a float vector to bytes', () => {
      const vec = [0.1, 0.2, 0.3]
      const packed = embeddings.packVec(vec)
      expect(Buffer.isBuffer(packed)).toBe(true)
      expect(packed.length).toBe(vec.length * 4)
    })

    it('should handle empty vectors', () => {
      const vec: number[] = []
      const packed = embeddings.packVec(vec)
      expect(packed.length).toBe(0)
    })

    it('should handle single-element vector', () => {
      const vec = [1.5]
      const packed = embeddings.packVec(vec)
      expect(packed.length).toBe(4)
    })

    it('should preserve vector values via IEEE 754 round-trip', () => {
      const vec = [0.0, -1.5, 3.14159, 1e-6]
      const packed = embeddings.packVec(vec)
      const view = new Float32Array(packed.buffer)
      for (let i = 0; i < vec.length; i++) {
        // Allow small floating-point rounding
        expect(Math.abs(view[i] - vec[i])).toBeLessThan(0.0001)
      }
    })

    it('should produce different output for different vectors', () => {
      const vec1 = [0.1, 0.2, 0.3]
      const vec2 = [0.1, 0.2, 0.4]
      const packed1 = embeddings.packVec(vec1)
      const packed2 = embeddings.packVec(vec2)
      expect(packed1.equals(packed2)).toBe(false)
    })
  })

  describe('chunkFile()', () => {
    it('should split file content into chunks', () => {
      // Create content larger than MIN_CHUNK_CHARS (50)
      const lines = Array(15)
        .fill(0)
        .map((_, i) => `line ${i + 1}`)
      const content = lines.join('\n')
      const chunks = embeddings.chunkFile('test.ts', content, 80, 0)
      expect(chunks.length).toBe(1)
      if (chunks.length > 0) {
        expect(chunks[0].filePath).toBe('test.ts')
      }
    })

    it('should respect minimum chunk size', () => {
      const shortContent = 'x'
      const chunks = embeddings.chunkFile('test.ts', shortContent)
      // Single character should be below MIN_CHUNK_CHARS (50)
      expect(chunks.length).toBe(0)
    })

    it('should create chunks with correct metadata', () => {
      const content = 'a'.repeat(100) + '\n' + 'b'.repeat(100)
      const chunks = embeddings.chunkFile('test.ts', content, 80)
      if (chunks.length > 0) {
        const chunk = chunks[0]
        expect(chunk.filePath).toBe('test.ts')
        expect(chunk.startLine).toBeGreaterThanOrEqual(1)
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
        expect(chunk.kind).toBe('window')
        expect(chunk.text.length).toBeGreaterThan(0)
      }
    })

    it('should handle files with many lines', () => {
      const lines = Array(1000)
        .fill(0)
        .map((_, i) => `function func${i}() { return ${i}; }`)
      const content = lines.join('\n')
      const chunks = embeddings.chunkFile('large.ts', content, 2000, 100)
      expect(chunks.length).toBe(19)
      // All chunks should be in the same file
      for (const chunk of chunks) {
        expect(chunk.filePath).toBe('large.ts')
      }
    })

    it('should handle empty file', () => {
      const chunks = embeddings.chunkFile('empty.ts', '')
      expect(chunks.length).toBe(0)
    })

    it('should set line numbers correctly', () => {
      const content = Array(50)
        .fill(0)
        .map((_, i) => `line ${i + 1}`)
        .join('\n')
      const chunks = embeddings.chunkFile('test.ts', content, 500)
      if (chunks.length > 0) {
        // startLine should be at least 1
        expect(chunks[0].startLine).toBeGreaterThanOrEqual(1)
        // endLine should be >= startLine
        for (const chunk of chunks) {
          expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
        }
      }
    })

    it('should handle Windows CRLF line endings correctly (regression: \\r?\\n split)', () => {
      const lines = Array(20)
        .fill(0)
        .map((_, i) => `const line${i} = "some content to make the file larger";`)
      const contentCRLF = lines.join('\r\n')
      const contentLF = lines.join('\n')

      const chunksCRLF = embeddings.chunkFile('test.ts', contentCRLF, 500)
      const chunksLF = embeddings.chunkFile('test.ts', contentLF, 500)

      // The regression this guards is that CRLF splitting behaves identically to LF splitting
      // (content.split(/\r?\n/) normalizes both) -- pin the exact, equal chunk count on both
      // sides instead of each independently being non-empty, which a mismatched count would
      // still satisfy.
      expect(chunksCRLF.length).toBe(4)
      expect(chunksLF.length).toBe(4)

      if (chunksCRLF.length > 0 && chunksLF.length > 0) {
        const crlfText = chunksCRLF[0].text
        const lfText = chunksLF[0].text

        expect(crlfText).not.toContain('\r')
        expect(lfText).not.toContain('\r')
      }
    })

    it('does not count a trailing newline as an extra line in endLine', () => {
      // 5 real lines, each long enough that the whole block exceeds MIN_CHUNK_CHARS (50) but stays well under MAX_CHUNK_CHARS (8000) so it forms exactly ONE final window chunk.
      const body =
        ['line one padding xx', 'line two padding xx', 'line three padding', 'line four padding x', 'line five padding x'].join('\n') + '\n'
      const chunks = embeddings.chunkFile('f.ts', body)
      expect(chunks.length).toBe(1)
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBe(5) // pre-fix: 6 (phantom trailing line counted) -> FAILS; post-fix: 5 -> PASSES
    })

    it('reports the correct endLine when content has no trailing newline', () => {
      const body =
        ['line one padding xx', 'line two padding xx', 'line three padding', 'line four padding x', 'line five padding x'].join('\n') // no trailing \n
      const chunks = embeddings.chunkFile('f.ts', body)
      expect(chunks.length).toBe(1)
      expect(chunks[0].endLine).toBe(5) // correct both pre- and post-fix
    })

    it('emits one chunk per boundary, tagged with the boundary kind and its exact line range', () => {
      const contentLines = [
        'function a() {', // 1
        '  return "aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa";', // 2
        '}', // 3
        'function b() {', // 4
        '  return "bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb";', // 5
        '}', // 6
        'function c() {', // 7
        '  return "cccc cccc cccc cccc cccc cccc cccc cccc";', // 8
        '}', // 9
      ]
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 1, end: 3, kind: 'symbol' },
        { start: 4, end: 6, kind: 'symbol' },
        { start: 7, end: 9, kind: 'symbol' },
      ]

      const chunks = embeddings.chunkFile('multi.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      expect(chunks.length).toBe(3)
      expect(chunks.map((c) => c.kind)).toEqual(['symbol', 'symbol', 'symbol'])
      expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
        [1, 3],
        [4, 6],
        [7, 9],
      ])
    })

    it('sub-splits an oversized boundary with the window logic, keeping the boundary kind and staying under the size cap', () => {
      const bodyLines = Array(50)
        .fill(0)
        .map((_, i) => `  line ${i} of the big function body padding text`)
      const contentLines = ['function big() {', ...bodyLines, '}']
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [{ start: 1, end: contentLines.length, kind: 'symbol' }]

      const chunkSize = 300
      const chunks = embeddings.chunkFile('big.ts', content, chunkSize, 50, boundaries)

      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) {
        expect(chunk.kind).toBe('symbol')
        expect(chunk.text.length).toBeLessThanOrEqual(chunkSize)
      }
      // The sub-split pieces still cover (at least) the original boundary's range.
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[chunks.length - 1].endLine).toBe(contentLines.length)
    })

    it('folds a small gap between two boundaries into the preceding chunk instead of emitting a standalone fragment', () => {
      const contentLines = [
        'function a() {', // 1
        '  return "aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa";', // 2
        '}', // 3
        '', // 4 - small gap, well under MIN_CHUNK_CHARS
        'function b() {', // 5
        '  return "bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb";', // 6
        '}', // 7
      ]
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 1, end: 3, kind: 'symbol' },
        { start: 5, end: 7, kind: 'symbol' },
      ]

      const chunks = embeddings.chunkFile('gap.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      expect(chunks.length).toBe(2)
      expect(chunks[0].kind).toBe('symbol')
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBe(4) // gap line 4 absorbed into the preceding boundary chunk
      expect(chunks[1].startLine).toBe(5)
      expect(chunks[1].endLine).toBe(7)
    })

    it('relabels kind to "window" when a short leading gap (no prior chunk range yet) is folded forward into the first boundary', () => {
      const contentLines = [
        '// short header comment', // 1 - small leading gap, well under MIN_CHUNK_CHARS, before any boundary
        'function a() {', // 2
        '  return "aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa";', // 3
        '}', // 4
      ]
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [{ start: 2, end: 4, kind: 'symbol' }]

      const chunks = embeddings.chunkFile('leadgap.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      expect(chunks.length).toBe(1)
      // The folded chunk now spans the leading comment line in addition to the
      // symbol's own lines, so it must not be mislabeled 'symbol' - it should carry
      // the generic 'window' kind, same as any other chunk that isn't exactly one
      // boundary's content.
      expect(chunks[0].kind).toBe('window')
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBe(4)
    })

    it('keeps a gap large enough to clear MIN_CHUNK_CHARS as its own standalone window chunk', () => {
      const fillerLines = Array(20)
        .fill(0)
        .map((_, i) => `// filler comment line ${i} padding text to be long enough`)
      const contentLines = [
        'function a() {', // 1
        '  return "aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa";', // 2
        '}', // 3
        ...fillerLines, // 4..23
        'function b() {', // 24
        '  return "bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb";', // 25
        '}', // 26
      ]
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 1, end: 3, kind: 'symbol' },
        { start: 24, end: 26, kind: 'symbol' },
      ]

      const chunks = embeddings.chunkFile('biggap.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      expect(chunks.length).toBe(3)
      expect(chunks[0].kind).toBe('symbol')
      expect(chunks[1].kind).toBe('window')
      expect(chunks[1].startLine).toBe(4)
      expect(chunks[1].endLine).toBe(23)
      expect(chunks[2].kind).toBe('symbol')
    })

    it('merges consecutive short boundaries too small on their own to clear MIN_CHUNK_CHARS, instead of dropping every one of them (regression: a barrel/const-module file previously indexed to zero chunks)', () => {
      const contentLines = ['const A = 1', 'const B = 2', 'const C = 3', 'const D = 4', 'const E = 5']
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = contentLines.map((_, i) => ({
        start: i + 1,
        end: i + 1,
        kind: 'const',
      }))

      const chunks = embeddings.chunkFile('barrel.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      expect(chunks.length).toBe(1)
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[chunks.length - 1].endLine).toBe(contentLines.length)
      expect(chunks.map((c) => c.text).join('\n')).toContain('const E = 5')
      // Must actually take the boundary-merging path (single-line start===end boundaries kept,
      // not silently filtered out and falling back to plain window splitting - a fallback would
      // still satisfy the loose assertions above without proving boundary merging ran at all).
      expect(chunks.every((c) => c.kind === 'const')).toBe(true)
    })

    it('clips a partially-overlapping boundary to start after the previously-accepted boundary instead of dropping it', () => {
      const contentLines = Array(30)
        .fill(0)
        .map((_, i) => `line ${i + 1} padding text to make each range clearly distinguishable`)
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 5, end: 15, kind: 'symbol' },
        { start: 10, end: 30, kind: 'symbol' }, // partially overlaps the first (starts inside it, extends past its end) - not nested
      ]

      const chunks = embeddings.chunkFile('overlap.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      // Both boundaries must produce their own chunk - not just `window 1-4 / symbol 5-15 / window 16-30`.
      expect(chunks.map((c) => c.kind)).toEqual(['window', 'symbol', 'symbol'])
      expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
        [1, 4],
        [5, 15],
        [16, 30], // second boundary clipped to start right after the first boundary's end (15), keeping its own 'symbol' kind
      ])
    })

    it('collapses two boundaries sharing the same start line to the outer (longer) one, not the inner one (regression: sort tie-break must be longest-first)', () => {
      const contentLines = Array(20)
        .fill(0)
        .map((_, i) => `line ${i + 1} padding text to make each range clearly distinguishable`)
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 1, end: 20, kind: 'class' }, // outer boundary, e.g. a class
        { start: 1, end: 5, kind: 'method' }, // inner boundary starting on the same line, e.g. a same-line method
      ]

      const chunks = embeddings.chunkFile('samestart.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      // The inner boundary is fully nested in the outer one and must be dropped entirely,
      // leaving exactly one chunk covering the whole outer range tagged with the outer kind.
      expect(chunks.length).toBe(1)
      expect(chunks[0].kind).toBe('class')
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBe(20)
    })

    it('clamps sub-split overlap to the boundary\'s own rangeStart instead of bleeding into the preceding, differently-tagged range', () => {
      const linesA = Array(5).fill(0).map((_, i) => `AAAA line ${i + 1}`)
      const linesB = Array(50).fill(0).map((_, i) => `BBBB line ${i + 1} padding text padding text padding`)
      const contentLines = [...linesA, ...linesB]
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 1, end: 5, kind: 'A' },
        { start: 6, end: contentLines.length, kind: 'B' }, // oversized, gets sub-split with overlap
      ]

      const chunks = embeddings.chunkFile('overlapclamp.ts', content, 100, 200, boundaries)

      for (const c of chunks) {
        if (c.kind === 'B') {
          expect(c.startLine).toBeGreaterThanOrEqual(6) // never dips back into A's lines (1-5)
          expect(c.text).not.toContain('AAAA')
        }
      }
    })
  })

  describe('mergeNearbyHits()', () => {
    it('should return empty array for empty input', () => {
      const result = embeddings.mergeNearbyHits([])
      expect(result).toEqual([])
    })

    it('should return single hit unchanged', () => {
      const hits: SearchHit[] = [
        {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          distance: 0.5,
          text: 'test',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits)
      expect(result).toEqual(hits)
    })

    it('should merge overlapping hits from same file', () => {
      const hits: SearchHit[] = [
        {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          distance: 0.5,
          text: 'test1',
        },
        {
          filePath: 'test.ts',
          startLine: 5,
          endLine: 15,
          kind: 'function',
          distance: 0.6,
          text: 'test2',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits, 20)
      expect(result.length).toBeLessThanOrEqual(hits.length)
      // After merge, should have combined range
      if (result.length > 0) {
        expect(result[0].startLine).toBeLessThanOrEqual(1)
        expect(result[0].endLine).toBeGreaterThanOrEqual(15)
      }
    })

    it('should keep hits from different files separate', () => {
      const hits: SearchHit[] = [
        {
          filePath: 'file1.ts',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          distance: 0.5,
          text: 'test1',
        },
        {
          filePath: 'file2.ts',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          distance: 0.5,
          text: 'test2',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits)
      expect(result.length).toBe(2)
    })

    it('should respect proximity threshold', () => {
      const hits: SearchHit[] = [
        {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 5,
          kind: 'function',
          distance: 0.5,
          text: 'test1',
        },
        {
          filePath: 'test.ts',
          startLine: 100,
          endLine: 105,
          kind: 'function',
          distance: 0.6,
          text: 'test2',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits, 5)
      // Should not merge (gap > proximity)
      expect(result.length).toBe(2)
    })

    it('should sort results by distance after merging', () => {
      const hits: SearchHit[] = [
        {
          filePath: 'test.ts',
          startLine: 20,
          endLine: 25,
          kind: 'function',
          distance: 0.8,
          text: 'test2',
        },
        {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          distance: 0.5,
          text: 'test1',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits)
      // Should be sorted by distance (ascending)
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].distance).toBeLessThanOrEqual(result[i + 1].distance)
      }
    })

    it('should keep best distance when merging', () => {
      const hits: SearchHit[] = [
        {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 10,
          kind: 'function',
          distance: 0.9,
          text: 'test1',
        },
        {
          filePath: 'test.ts',
          startLine: 8,
          endLine: 15,
          kind: 'function',
          distance: 0.5,
          text: 'test2',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits, 20)
      if (result.length > 0) {
        // Merged result should have the best (lowest) distance
        expect(result[0].distance).toBe(0.5)
      }
    })
  })

  describe('cmdSemantic over-fetch + merge composition (regression: merge before truncate, not after)', () => {
    // Simulates rerankHits' best-first output for a single semantic-search call: three hits in
    // the same file, ordered by ascending (already re-ranked) distance. Hit A and hit C sit close
    // enough together (gap of 4 lines, within the default proximity of 20) that mergeNearbyHits
    // should combine them into one hit; hit B is far away in the same file and never merges.
    const hit = (startLine: number, endLine: number, distance: number, text: string): SearchHit => ({
      filePath: 'src/auth.ts',
      startLine,
      endLine,
      kind: 'window',
      distance,
      text,
    })
    const rawHits: SearchHit[] = [
      hit(1, 10, 0.1, 'chunk A'),
      hit(500, 510, 0.15, 'chunk B'),
      hit(15, 25, 0.2, 'chunk C'),
    ]
    const n = 2

    it('drops a mergeable hit when truncating to n before merging (the pre-fix composition)', () => {
      // Old cmdSemantic: searchSemantic already truncated to n=2 raw hits (best-first: A, B)
      // before mergeNearbyHits ever ran, so chunk C never gets a chance to merge with chunk A.
      const preFixResult = embeddings.mergeNearbyHits(rawHits.slice(0, n))
      expect(preFixResult.length).toBe(2)
      const authHit = preFixResult.find((h) => h.startLine === 1)
      expect(authHit?.endLine).toBe(10) // NOT extended to 25 - the merge that should happen never does
    })

    it('merges the over-fetched candidate pool before truncating to n (the fixed composition)', () => {
      // New cmdSemantic: searchSemantic over-fetches all 3 candidates, mergeNearbyHits runs on
      // the full pool first, and only the merged result is truncated to n.
      const postFixResult = embeddings.mergeNearbyHits(rawHits).slice(0, n)
      expect(postFixResult.length).toBe(2)
      const mergedHit = postFixResult.find((h) => h.startLine === 1)
      expect(mergedHit?.endLine).toBe(25) // extended to cover chunk C - the merge happened
      expect(mergedHit?.text).toContain('chunk A')
      expect(mergedHit?.text).toContain('chunk C')
      expect(mergedHit?.distance).toBe(0.1) // keeps the best distance of the merged pair
    })
  })

  describe('rerankHits()', () => {
    const mk = (filePath: string, distance: number, text: string): SearchHit => ({
      filePath,
      startLine: 1,
      endLine: 2,
      kind: 'window',
      distance,
      text,
    })

    it('demotes hits under generated/build directories below source hits', () => {
      // 'authenticate' appears in neither text, so boost is 0 on both — pure penalty test.
      const hits = [mk('dist/bundle.js', 0.4, 'some code'), mk('src/auth.ts', 0.5, 'other code')]
      const out = embeddings.rerankHits(hits, 'authenticate', 8)
      // dist/ hit has the lower raw distance but is demoted by the generated-path penalty.
      expect(out[0].filePath).toBe('src/auth.ts')
      expect(out.map((h) => h.distance)).toContain(0.4) // hit is reordered, not dropped; raw distance preserved
    })

    it('demotes hits under capitalized generated/build directories the same as lowercase', () => {
      // 'authenticate' appears in neither text, so boost is 0 on both — pure penalty test.
      const hits = [mk('Dist/bundle.js', 0.4, 'some code'), mk('src/auth.ts', 0.5, 'other code')]
      const out = embeddings.rerankHits(hits, 'authenticate', 8)
      // Dist/ (capitalized) hit has the lower raw distance but must still be demoted, matching
      // the lowercase dist/ case above — segment matching against _GENERATED_PATH_SEGMENTS is
      // case-insensitive.
      expect(out[0].filePath).toBe('src/auth.ts')
      expect(out.map((h) => h.distance)).toContain(0.4)
    })

    it('boosts hits whose text contains verbatim query tokens above closer non-matches', () => {
      const hits = [
        mk('src/b.ts', 0.55, 'totally unrelated code'),
        mk('src/a.ts', 0.6, 'function login() { return handler() }'),
      ]
      // query has two tokens both present in a.ts: boost 2 * 0.05 = 0.10 -> 0.60 - 0.10 = 0.50 < 0.55
      const out = embeddings.rerankHits(hits, 'login handler', 8)
      expect(out[0].filePath).toBe('src/a.ts')
    })

    it('truncates to topK after re-ranking', () => {
      const hits = [mk('src/a.ts', 0.3, 'x'), mk('src/b.ts', 0.4, 'y'), mk('src/c.ts', 0.5, 'z')]
      const out = embeddings.rerankHits(hits, 'irrelevant', 2)
      expect(out.length).toBe(2)
    })
  })

  describe('constants', () => {
    it('should export DEFAULT_DIM as 384', () => {
      expect(embeddings.DEFAULT_DIM).toBe(384)
    })

    it('should export DEFAULT_MODEL', () => {
      expect(typeof embeddings.DEFAULT_MODEL).toBe('string')
      expect(embeddings.DEFAULT_MODEL).toContain('bge')
    })

    it('should export MIN_CHUNK_CHARS as 50', () => {
      expect(embeddings.MIN_CHUNK_CHARS).toBe(50)
    })

    it('should export MAX_CHUNK_CHARS as 8000', () => {
      expect(embeddings.MAX_CHUNK_CHARS).toBe(8000)
    })

    it('should export WINDOW_LINES as 100', () => {
      expect(embeddings.WINDOW_LINES).toBe(100)
    })

    it('should export DEFAULT_DISTANCE_THRESHOLD as 1.2', () => {
      expect(embeddings.DEFAULT_DISTANCE_THRESHOLD).toBe(1.2)
    })

    it('should export OVER_FETCH_FACTOR as 4', () => {
      expect(embeddings.OVER_FETCH_FACTOR).toBe(4)
    })

    it('should export MAX_OVER_FETCH as 100', () => {
      expect(embeddings.MAX_OVER_FETCH).toBe(100)
    })
  })

  describe('embedTexts() graceful degradation', () => {
    it('should throw or return empty if transformer unavailable', async () => {
      if (!embeddings.isAvailable()) {
        // If transformer is not available, embedTexts should throw
        try {
          await embeddings.embedTexts(['test'])
          // If it doesn't throw, it should at least return empty or valid data
        } catch (e) {
          expect(e).toBeInstanceOf(Error)
        }
      } else {
        // If transformer is available, this test is skipped
        expect(embeddings.isAvailable()).toBe(true)
      }
    })
  })

  describe('searchSemantic() graceful degradation', () => {
    it('should return empty array if transformer unavailable', async () => {
      if (!embeddings.isAvailable()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = {} as any
        const result = await embeddings.searchSemantic(db, 'test query')
        expect(Array.isArray(result)).toBe(true)
        expect(result.length).toBe(0)
      } else {
        expect(embeddings.isAvailable()).toBe(true)
      }
    })

    it('should return empty array for empty query', async () => {
      if (!embeddings.isAvailable()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = {} as any
        const result = await embeddings.searchSemantic(db, '   ')
        expect(result).toEqual([])
      }
    })
  })

  describe('searchSemantic() SQL vector matching', () => {
    it('should pass query vector via MATCH clause (not omit it)', async () => {
      if (!embeddings.isAvailable()) {
        return
      }
      // Verify the query issued to sqlite uses the embedded vector (MATCH ?) rather than a bare ORDER BY with no WHERE clause.
      const preparedStatements: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockDb: any = {
        prepare: (sql: string) => {
          preparedStatements.push(sql)
          return {
            all: () => [],
            // chunk_vectors existence probe (searchSemantic gate) - return a row so the gate passes and the KNN query under test runs.
            get: () => ({}),
          }
        },
      }
      await embeddings.searchSemantic(mockDb, 'find auth functions')
      const sql = preparedStatements.join('\n')
      expect(sql).toContain('WHERE embedding MATCH')
      expect(sql).toContain('embedding')
    })
  })
})
