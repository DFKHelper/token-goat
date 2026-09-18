import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { chunkFile, MAX_CHUNK_CHARS, type Chunk } from '../src/embeddings.js'
import { BertWordPiece, MAX_SEQUENCE_TOKENS } from '../src/embed_tokenizer.js'

// PROVENANCE: CAPTURE -- tests/fixtures/wordpiece/tokenizer.json.gz is the pinned bge-small-en-v1.5 tokenizer.json itself (see tests/embed_tokenizer_oracle.test.ts), so a count here is what the model is fed, not a char-count proxy for it.
const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wordpiece')
const tokenizer = new BertWordPiece(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(fixtureDir, 'tokenizer.json.gz'))).toString('utf8')))
const countTokens = (text: string): number => tokenizer.countTokens(text)

// PROVENANCE: HAND-DERIVED -- dense code with long snake_case identifiers and hex literals, the worst case for chars per wordpiece: every underscore, bracket and comma is a token of its own. 120 lines of about 150 chars each, one symbol wrapping all of them, and a 19,560-char minified line after it.
const denseLines = Array.from({ length: 120 }, (_, i) => `  const reconciled_offset_table_${i} = merge_partition_descriptors(shard_lookup_0x${(i * 7919).toString(16)}, [0x${i.toString(16)}, 0x7f, ${i}], { retry_budget_ms: ${i * 13}, stale_cutoff: true })`)
const minified = Array.from({ length: 800 }, (_, i) => `a${i}.b_${i}(c[${i}],d_${i});`).join('')
const content = ['export function rebuildPartitionIndex(): void {', ...denseLines, '}', minified, ''].join('\n')
const functionEnd = denseLines.length + 2
const minifiedLine = functionEnd + 1

function tokensFed(chunk: Chunk): number {
  // Documents are embedded with no prefix (only the query side gets QUERY_INSTRUCTION_PREFIX), so the chunk text is exactly what the model encodes.
  return tokenizer.encode(chunk.text, Number.MAX_SAFE_INTEGER).length
}

describe('chunkFile() under the embedding model token budget', () => {
  const chunks = chunkFile('dense.ts', content, MAX_CHUNK_CHARS, 200, [{ start: 1, end: functionEnd, kind: 'symbol' }], countTokens)

  it('the input is one the old char cap let through too long, so the budget below is what is doing the work', () => {
    const charCapped = chunkFile('dense.ts', content, MAX_CHUNK_CHARS, 200, [{ start: 1, end: functionEnd, kind: 'symbol' }])
    expect(Math.max(...charCapped.map(tokensFed))).toBeGreaterThan(MAX_SEQUENCE_TOKENS)
  })

  it('emits no chunk the model would truncate: every chunk encodes, [CLS] and [SEP] included, to at most MAX_SEQUENCE_TOKENS', () => {
    const over = chunks.filter((c) => tokensFed(c) > MAX_SEQUENCE_TOKENS).map((c) => `${c.startLine}-${c.endLine}: ${tokensFed(c)} tokens`)
    expect(over).toEqual([])
  })

  it('loses no source text: every line of the function sits in a chunk covering it, and the minified line is reassembled from its pieces', () => {
    const lines = content.split('\n')
    for (let lineNo = 1; lineNo <= functionEnd; lineNo++) {
      const line = lines[lineNo - 1]!.trim()
      expect(chunks.some((c) => c.startLine <= lineNo && lineNo <= c.endLine && c.text.includes(line)), `line ${lineNo}`).toBe(true)
    }
    const pieces = chunks.filter((c) => c.startLine === minifiedLine).map((c) => c.text.split('\n')[0]!)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.join('')).toBe(minified)
  })

  it('does not carry overlap, or fold a trailing fragment, into a chunk the next line already nearly fills', () => {
    // PROVENANCE: HAND-DERIVED -- a short line under the 200-char overlap window, then a line of 480 wordpieces (v, _, n and a comma, 120 times), so the pair is over the budget while each fits alone.
    const short = '  s_1, s_2, s_3, s_4, s_5, s_6, s_7, s_8'
    const long = Array.from({ length: 120 }, (_, i) => `v_${i},`).join(' ')
    expect(countTokens(short) + countTokens(long)).toBeGreaterThan(MAX_SEQUENCE_TOKENS - 2)
    expect(countTokens(long)).toBeLessThanOrEqual(MAX_SEQUENCE_TOKENS - 2)
    // Ending on the short line also makes the file's last fragment one the final flush would fold back into a full chunk.
    const alternating = [...Array.from({ length: 6 }, () => [short, long]).flat(), short].join('\n')
    const cut = chunkFile('alternating.txt', alternating, MAX_CHUNK_CHARS, 200, [], countTokens)
    expect(cut.filter((c) => tokensFed(c) > MAX_SEQUENCE_TOKENS).map((c) => `${c.startLine}-${c.endLine}: ${tokensFed(c)} tokens`)).toEqual([])
  })
})
