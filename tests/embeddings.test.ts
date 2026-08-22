import { describe, it, expect, afterEach } from 'vitest'
import * as embeddings from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import { defaultConfig, saveConfig, invalidateConfigCache } from '../src/config.js'

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

  describe('chunkFile() on a file whose lines are much wider than the overlap budget', () => {
    // `overlap` is documented as a character budget, but it was turned into a line count with
    // `Math.ceil(overlap / 40)` -- a fixed 5 lines for the default 200, whatever those lines
    // actually held. On lines wider than the 40-char guess that fixed count was the only bound,
    // and it bounded the wrong quantity: each chunk was prefilled with 5 whole lines of overlap,
    // which on 3,000-char lines is 15,000 characters rather than 200. Chunks were stored at
    // 18,005 chars against a MAX_CHUNK_CHARS of 8,000 -- past the size cap this function exists
    // to enforce, and past the embedding model's context window it is set from -- and the
    // database held 5.84x the source it was indexing, every duplicated byte embedded too.
    // Minified bundles, generated code, long CSV or log lines and single-line JSON all qualify.
    const LINE_CHARS = 3000
    const LINE_COUNT = 100
    const content = Array.from({ length: LINE_COUNT }, (_, i) =>
      `${String(i).padStart(4, '0')}${'x'.repeat(LINE_CHARS - 4)}`,
    ).join('\n')

    it('keeps every chunk within the documented size cap', () => {
      const chunks = embeddings.chunkFile('wide.ts', content)

      expect(chunks.length).toBeGreaterThan(0)
      const oversized = chunks.filter((c) => c.text.length > embeddings.MAX_CHUNK_CHARS)
      expect(oversized.map((c) => [c.startLine, c.text.length])).toEqual([])
    })

    it('does not store several times the source it is indexing', () => {
      const chunks = embeddings.chunkFile('wide.ts', content)

      // Some duplication is the point of overlap, so this is not a demand for exactly 1.00x --
      // it is a bound loose enough that honest overlap passes and the 5.84x measured before the
      // fix cannot. The whole-file numbers are asserted rather than a per-chunk ratio because
      // amplification is what actually costs storage and embedding time.
      const stored = chunks.reduce((total, c) => total + c.text.length, 0)
      expect(stored).toBeLessThan(content.length * 1.5)
    })

    it('still overlaps consecutive chunks when the lines do fit the budget', () => {
      // The fix must not become "no overlap ever". On lines narrow enough for the 200-char
      // budget to cover several, consecutive chunks still have to share lines, or the guard
      // above would be satisfied by simply deleting the overlap.
      const narrow = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i}`).join('\n')

      const chunks = embeddings.chunkFile('narrow.ts', narrow, 500)

      expect(chunks.length).toBeGreaterThan(1)
      // Reported as the offending boundaries rather than a collapsed boolean, so a failure says
      // which chunk pairs stopped sharing lines instead of only "expected false to be true".
      const notOverlapping = chunks
        .slice(1)
        .map((c, i) => ({ after: chunks[i].endLine, startsAt: c.startLine }))
        .filter((pair) => pair.startsAt > pair.after)
      expect(notOverlapping).toEqual([])
    })
  })

  describe('chunkFile() on content that never clears the minimum chunk size', () => {
    // A below-floor chunk is dropped rather than emitted, and the window used to be pinned back to
    // that chunk's own start so its lines could not be lost. For content that trims to nothing the
    // pin never lifted: `startLine` stopped advancing, the buffer grew without bound, and every
    // following line re-tripped the size flush and re-ran `trim()` over an ever-longer string.
    // 8,000 blank lines took 127 ms and 64,000 took 11.3 s -- an 89-fold rise for an 8-fold input --
    // and every run produced no chunks at all. Note the size below is deliberately large: the same
    // commit also stopped this loop rebuilding a string it already had, which on its own cut the
    // cost enough that a smaller file no longer separates a fixed loop from a quadratic one.
    //
    // Only the cost is asserted here. What the pin is for -- keeping the lines of a dropped
    // below-floor chunk -- is already pinned by the short-lines-before-a-long-line case below, and
    // that case goes red if this narrowing ever widens back into removing the pin outright. The indexer accepts files up to 500 KB, where that
    // extrapolates to minutes of one core inside the worker's drain loop, spent to produce nothing.
    it('does not take quadratic time on a file that is entirely blank lines', () => {
      const started = Date.now()

      const chunks = embeddings.chunkFile('blank.txt', '\n'.repeat(128_000))

      expect(chunks).toEqual([])
      // At this size the fixed loop takes about 5 ms and the quadratic one about 6,300 ms, so the
      // bound sits several hundred times above the real cost and three times below the defect --
      // it cannot fire on a slow or loaded machine, and the quadratic cannot slip under it.
      expect(Date.now() - started).toBeLessThan(2_000)
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
      expect(chunks[0]!.filePath).toBe('test.ts')
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
      // Regression: the original `if (chunks.length > 0)` guard meant this test's body could
      // silently execute zero assertions if chunking ever regressed to an empty result -- pin the
      // real chunk count instead so that failure mode is caught rather than passing trivially.
      expect(chunks.length).toBe(2)
      const chunk = chunks[0]
      expect(chunk.filePath).toBe('test.ts')
      expect(chunk.startLine).toBe(1)
      expect(chunk.endLine).toBe(1)
      expect(chunk.kind).toBe('window')
      expect(chunk.text.length).toBe(100)
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
      // A 50-line file with chunkSize 500 fits in a single window chunk.
      expect(chunks.length).toBe(1)
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBe(50)
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
      // (content.split(/\r?\n/) normalizes both). Compare the two runs against each other rather
      // than against a literal chunk count: the count a given input splits into is a function of
      // the overlap and size tunables, so a literal pins this test to their current values and
      // fails when they are legitimately retuned, while saying nothing about CRLF at all. Every
      // chunk's line range and text must match across the two, which is the actual claim and is
      // stronger than an equal count -- a per-chunk boundary that diverged while the totals
      // happened to agree would satisfy a count pin and fails here.
      expect(chunksCRLF.map((c) => [c.startLine, c.endLine, c.text])).toEqual(
        chunksLF.map((c) => [c.startLine, c.endLine, c.text]),
      )
      // ...and the file must actually have split, or the comparison above is vacuously true for
      // any two single-chunk results.
      expect(chunksLF.length).toBeGreaterThan(1)

      const crlfText = chunksCRLF[0].text
      const lfText = chunksLF[0].text

      expect(crlfText).not.toContain('\r')
      expect(lfText).not.toContain('\r')
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
        kind: 'symbol',
      }))

      const chunks = embeddings.chunkFile('barrel.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      expect(chunks.length).toBe(1)
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[chunks.length - 1].endLine).toBe(contentLines.length)
      expect(chunks.map((c) => c.text).join('\n')).toContain('const E = 5')
      // Must actually take the boundary-merging path (single-line start===end boundaries kept,
      // not silently filtered out and falling back to plain window splitting - a fallback would
      // still satisfy the loose assertions above without proving boundary merging ran at all).
      expect(chunks.every((c) => c.kind === 'symbol')).toBe(true)
    })

    it('does not silently drop short lines that precede a single line long enough alone to trip the size-based flush (regression: splitRangeIntoChunks discarded a below-MIN_CHUNK_CHARS flushed chunk and recomputed its overlap window purely from currentLine, which can land after that dropped chunk\'s own start when the dropped chunk spans more lines than the overlap window covers -- those lines then appeared in NO emitted chunk, silently absent from the semantic index)', () => {
      const shortLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
      const hugeLine = 'y'.repeat(embeddings.MAX_CHUNK_CHARS + 500)
      const content = [...shortLines, hugeLine].join('\n')

      const chunks = embeddings.chunkFile('huge-tail.ts', content, embeddings.MAX_CHUNK_CHARS, 200, [])

      const covered = new Set<number>()
      for (const c of chunks) {
        for (let line = c.startLine; line <= c.endLine; line++) covered.add(line)
      }
      const totalLines = content.split('\n').length
      for (let line = 1; line <= totalLines; line++) {
        expect(covered.has(line)).toBe(true)
      }
    })

    it('never emits a chunk whose trimmed text is empty (regression: the too-small check compared MIN_CHUNK_CHARS against the untrimmed buffer length while the pushed text was the trimmed buffer, so a long run of whitespace-only lines -- long enough in raw chars to clear MIN_CHUNK_CHARS but entirely blank once trimmed -- was pushed as a chunk with text === "")', () => {
      const blankLines = Array.from({ length: 30 }, () => '   ') // whitespace-only, long enough in raw chars
      const realLine = 'real content line that is not blank'
      const content = [...blankLines, realLine].join('\n')

      const chunks = embeddings.chunkFile('blank-run.ts', content, 60, 5, [
        { start: 1, end: blankLines.length + 1, kind: 'symbol' },
      ])

      for (const c of chunks) {
        expect(c.text.trim().length).toBeGreaterThan(0)
      }
    })

    it('does not silently drop a boundary range whose real content is interspersed with enough whitespace to clear MIN_CHUNK_CHARS in raw chars but not in trimmed chars (regression: chunkFile\'s own boundary/gap pre-filter (gapLength) measured raw length, disagreeing with splitRangeIntoChunks\' now-trimmed-length too-small check -- a whitespace-heavy leading boundary range passed the outer "big enough to stand alone" check, was handed to splitRangeIntoChunks as a lone range with no accumulated chunks yet, and was silently dropped there instead of being folded into a neighbor, taking its real content line down with it)', () => {
      // A short leading boundary section: 3 whitespace-only lines followed by one real line -- big
      // enough in raw chars (with newlines) to clear MIN_CHUNK_CHARS as a standalone range, but not
      // once trimmed.
      const leadingBoundaryLines = ['                                              ', '   ', '   ', 'const real = 1']
      const restOfFile = Array.from({ length: 5 }, (_, i) => `function f${i}() { return ${i}; }`)
      const contentLines = [...leadingBoundaryLines, ...restOfFile]
      const content = contentLines.join('\n')

      const chunks = embeddings.chunkFile('leading-blank-boundary.ts', content, embeddings.MAX_CHUNK_CHARS, 200, [
        { start: 1, end: leadingBoundaryLines.length, kind: 'symbol' },
      ])

      const covered = new Set<number>()
      for (const c of chunks) {
        for (let line = c.startLine; line <= c.endLine; line++) covered.add(line)
      }
      // Line 4 ("const real = 1") must land in some chunk -- it is real content and must never be
      // silently lost, regardless of how the surrounding whitespace gets folded.
      expect(covered.has(4)).toBe(true)
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
        { start: 1, end: 20, kind: 'symbol' }, // outer boundary, e.g. a class
        { start: 1, end: 5, kind: 'section' }, // inner boundary starting on the same line, e.g. a same-line method
      ]

      const chunks = embeddings.chunkFile('samestart.ts', content, embeddings.MAX_CHUNK_CHARS, 200, boundaries)

      // The inner boundary is fully nested in the outer one and must be dropped entirely,
      // leaving exactly one chunk covering the whole outer range tagged with the outer kind.
      expect(chunks.length).toBe(1)
      expect(chunks[0].kind).toBe('symbol')
      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBe(20)
    })

    it('clamps sub-split overlap to the boundary\'s own rangeStart instead of bleeding into the preceding, differently-tagged range', () => {
      const linesA = Array(5).fill(0).map((_, i) => `AAAA line ${i + 1}`)
      const linesB = Array(50).fill(0).map((_, i) => `BBBB line ${i + 1} padding text padding text padding`)
      const contentLines = [...linesA, ...linesB]
      const content = contentLines.join('\n')
      const boundaries: embeddings.ChunkBoundary[] = [
        { start: 1, end: 5, kind: 'symbol' },
        { start: 6, end: contentLines.length, kind: 'section' }, // oversized, gets sub-split with overlap
      ]

      const chunks = embeddings.chunkFile('overlapclamp.ts', content, 100, 200, boundaries)

      for (const c of chunks) {
        if (c.kind === 'section') {
          expect(c.startLine).toBeGreaterThanOrEqual(6) // never dips back into the 'symbol' boundary's lines (1-5)
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
      // Overlapping ranges [1,10] and [5,15] merge into exactly one hit covering [1,15].
      expect(result.length).toBe(1)
      expect(result[0].startLine).toBe(1)
      expect(result[0].endLine).toBe(15)
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

    it('merges when the gap between hits sits exactly at the proximity boundary (mutation-testing gap: the check must be <=, not <)', () => {
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
          // gap = startLine - endLine - 1 = 16 - 10 - 1 = 5, exactly equal to proximity below.
          filePath: 'test.ts',
          startLine: 16,
          endLine: 20,
          kind: 'function',
          distance: 0.6,
          text: 'test2',
        },
      ]
      const result = embeddings.mergeNearbyHits(hits, 5)
      expect(result.length).toBe(1)
      expect(result[0]?.startLine).toBe(1)
      expect(result[0]?.endLine).toBe(20)
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
      // Overlapping ranges [1,10] and [8,15] merge into exactly one hit.
      expect(result.length).toBe(1)
      // Merged result should have the best (lowest) distance
      expect(result[0].distance).toBe(0.5)
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

    it('boosts a hit for a 3-character query token, the minimum counted token length (mutation-testing gap: the length check must be >=, not >)', () => {
      const hits = [
        mk('src/a.ts', 0.53, 'the log rotates nightly'),
        mk('src/b.ts', 0.5, 'totally unrelated content'),
      ]
      // 'log' is exactly _MIN_TOKEN_LEN (3) chars; with the boost applied, a.ts's adjusted
      // distance (0.53 - 0.05 = 0.48) beats b.ts's raw 0.5. Without it, b.ts (lower raw
      // distance, no boost either way) would win instead.
      const out = embeddings.rerankHits(hits, 'log', 8)
      expect(out[0].filePath).toBe('src/a.ts')
    })

    it('truncates to topK after re-ranking', () => {
      const hits = [mk('src/a.ts', 0.3, 'x'), mk('src/b.ts', 0.4, 'y'), mk('src/c.ts', 0.5, 'z')]
      const out = embeddings.rerankHits(hits, 'irrelevant', 2)
      expect(out.length).toBe(2)
    })

    describe('path-priority scoring (deprioritizes archival/superseded and docs paths)', () => {
      afterEach(() => {
        // Restore the default semantic weights after any test that overrides them, so a later
        // test in this file (or another file sharing the isolated TOKEN_GOAT_HOME) never sees a
        // config.toml left behind with a non-default archive_weight/docs_weight.
        saveConfig(defaultConfig())
        invalidateConfigCache()
      })

      it('ranks live source ahead of an archival hit with slightly higher raw similarity (lower distance)', () => {
        // 'design' appears in neither text, so boost is 0 on both -- pure path-priority test.
        // archive/old-design.md's raw distance (0.40) is better (lower) than src/thing.ts's
        // (0.45), but the default archive_weight (0.7) demotes it: 0.40 + (1 - 0.7) = 0.70 > 0.45.
        const hits = [
          mk('archive/old-design.md', 0.40, 'legacy notes about the thing'),
          mk('src/thing.ts', 0.45, 'export function thing() {}'),
        ]
        const out = embeddings.rerankHits(hits, 'design', 8)
        expect(out.map((h) => h.filePath)).toEqual(['src/thing.ts', 'archive/old-design.md'])
        // Reordered, not dropped: the archival hit's raw distance survives untouched.
        expect(out.map((h) => h.distance)).toEqual([0.45, 0.40])
      })

      it('still surfaces a much better archival match (nudge, not a hard filter)', () => {
        // archive/old-design.md's raw distance (0.10) is so much better than src/thing.ts's
        // (0.45) that even penalized by archive_weight (0.10 + 0.30 = 0.40) it still beats 0.45.
        const hits = [
          mk('archive/old-design.md', 0.10, 'legacy notes about the thing'),
          mk('src/thing.ts', 0.45, 'export function thing() {}'),
        ]
        const out = embeddings.rerankHits(hits, 'design', 8)
        expect(out.map((h) => h.filePath)).toEqual(['archive/old-design.md', 'src/thing.ts'])
      })

      // Regression: the penalty was first applied as a DIVISOR on `distance - boost`. That term goes
      // negative whenever a hit's raw distance falls below _MAX_VERBATIM_BOOST (0.25), which any
      // near-verbatim match does, and dividing a negative number by a weight < 1 makes it MORE
      // negative -- so the archival penalty silently became an archival BONUS for exactly the
      // strongest matches, the ones most likely to be followed. Both hits below share the query
      // tokens, so both earn the same full boost and the ONLY difference is the path penalty.
      it('still demotes an archival hit when the verbatim boost drives the score negative', () => {
        const text = 'compact session manifest token budget'
        const hits = [
          mk('archive/old-design.md', 0.20, text),
          mk('src/thing.ts', 0.22, text),
        ]
        const out = embeddings.rerankHits(hits, text, 8)
        expect(out.map((h) => h.filePath)).toEqual(['src/thing.ts', 'archive/old-design.md'])
      })

      it('disables the archive penalty when semantic.archive_weight is set to 1', () => {
        const cfg = defaultConfig()
        cfg.semantic.archive_weight = 1
        saveConfig(cfg)
        invalidateConfigCache()

        // Same inputs as the first test above -- with the penalty off, pure raw-distance
        // ordering wins and the archival hit (lower raw distance) now ranks first.
        const hits = [
          mk('archive/old-design.md', 0.40, 'legacy notes about the thing'),
          mk('src/thing.ts', 0.45, 'export function thing() {}'),
        ]
        const out = embeddings.rerankHits(hits, 'design', 8)
        expect(out.map((h) => h.filePath)).toEqual(['archive/old-design.md', 'src/thing.ts'])
      })
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
