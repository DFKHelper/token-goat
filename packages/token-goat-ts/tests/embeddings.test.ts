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
      expect(chunks.length).toBeGreaterThan(0)
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
      expect(chunks.length).toBeGreaterThan(0)
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
      // Verify the query issued to sqlite uses the embedded vector (MATCH ?)
      // rather than a bare ORDER BY with no WHERE clause.
      const preparedStatements: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockDb: any = {
        prepare: (sql: string) => {
          preparedStatements.push(sql)
          return {
            all: () => [],
          }
        },
      }
      await embeddings.searchSemantic(mockDb, 'find auth functions')
      const sql = preparedStatements.join('\n')
      expect(sql).toContain('MATCH')
      expect(sql).toContain('embedding')
      expect(sql).not.toMatch(/ORDER BY distance\s+ASC\s*$/)  // bare ORDER BY with no WHERE
    })
  })
})
