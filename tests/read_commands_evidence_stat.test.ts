/**
 * Regression: runSemantic's workspace-evidence fallback branch (added alongside
 * searchEvidenceSemantically) passed a literal `0` as recordReadStat's fullSourceBytes, which
 * floors bytes_saved at `Math.max(1, 0 - emittedBytes)` = 1 no matter how large the cached
 * evidence actually was. Every other semantic_search call site sums the real source size (e.g.
 * sumFileSizes(hits.map(h => h.filePath))); the evidence branch must credit the real cached text
 * size the same way, not a constant 1-byte stub.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let testDataDir = ''

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, dataDir: () => testDataDir }
})

import { recordEvidence } from '../src/evidence_cache.js'
import { setPipelineFnForTesting } from '../src/embeddings.js'
import { runSemantic } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'
import { clearModuleCaches } from '../src/reset.js'

beforeEach(() => {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evidence-stat-'))
  setPipelineFnForTesting(async () => async () => {
    const vector = new Float32Array(384)
    vector[0] = 1
    return { data: vector }
  })
})

afterEach(() => {
  clearModuleCaches()
  fs.rmSync(testDataDir, { recursive: true, force: true })
})

describe('runSemantic workspace-evidence fallback bytes_saved (regression)', () => {
  it('credits the real cached evidence text size, not a flat 1 byte', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evidence-stat-project-'))
    try {
      const largeText = 'marine biology finding line\n'.repeat(500)
      recordEvidence({
        projectRoot: project,
        source: path.join(project, 'ocean.md'),
        representation: 'file',
        text: largeText,
      })

      const before = summarize(30).by_kind['semantic_search']
      const beforeBytes = before?.bytes_saved ?? 0

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project)
      let result: { text: string; code: number }
      try {
        result = await runSemantic('marine biology', {})
      } finally {
        cwdSpy.mockRestore()
      }
      expect(result.code).toBe(0)

      const after = summarize(30).by_kind['semantic_search']
      const gain = (after?.bytes_saved ?? 0) - beforeBytes
      // Pinned to the exact arithmetic rather than a floor: the whole cached text less what was
      // actually emitted. A floor like "> 1000" passes just as happily on a credit computed from
      // the wrong quantity, which is the failure this file exists to catch.
      const emitted = Buffer.byteLength(result.text, 'utf8')
      expect(gain).toBe(Buffer.byteLength(largeText, 'utf8') - emitted)
      // And the arithmetic is only meaningful if the emitted preview really is the smaller of the
      // two: were it larger, Math.max(1, ...) would floor the result and the equality above would
      // be pinning the floor rather than the credit.
      expect(emitted).toBeLessThan(Buffer.byteLength(largeText, 'utf8'))
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
