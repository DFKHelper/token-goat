/** The embedding chunker cuts a lone-CR (classic Mac) file into the same lines the parser indexed, so each chunk's start/end lines agree with the symbol rows and with what `read` slices. It used to split on /\r?\n/ only, so the whole file became one chunk labelled 1-1. Drives the real indexFileSync + buildEmbeddingBoundaries + chunkFile. PROVENANCE: HAND-DERIVED. Two TypeScript functions of four lines each, joined with a lone CR; the expected spans (1-4 and 5-8) are counted from the lines by hand, independently of the extractor. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { chunkFile } from '../src/embeddings.js'
import { buildEmbeddingBoundaries, indexFileSync } from '../src/parser.js'

const BODY = (name: string): string[] => [
  `export function ${name}() {`,
  `  const label = 'a line long enough that this function clears the minimum chunk size'`,
  `  return label.length`,
  `}`,
]
const LINES = [...BODY('alpha'), ...BODY('beta')]

describe('chunkFile on old-Mac line endings', () => {
  for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
    it(`${label}: chunk lines match the indexed symbol spans`, () => {
      const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tg-cr-chunk-'))
      try {
        const dbPath = path.join(TMP, 'index.db')
        const filePath = path.join(TMP, 'mac.ts')
        const content = LINES.join(eol) + eol
        fs.writeFileSync(filePath, content, 'utf8')
        indexFileSync(filePath, dbPath)
        const boundaries = buildEmbeddingBoundaries(filePath, content, dbPath)
        expect(boundaries.map((b) => `${b.start}-${b.end}`)).toEqual(['1-4', '5-8'])
        const chunks = chunkFile(filePath, content, undefined, undefined, boundaries)
        expect(chunks.map((c) => `${c.startLine}-${c.endLine}`)).toEqual(['1-4', '5-8'])
        expect(chunks[1]!.text).toContain('function beta')
        expect(chunks[1]!.text).not.toContain('alpha')
      } finally {
        closeAllDbs()
        fs.rmSync(TMP, { recursive: true, force: true })
      }
    })
  }
})
