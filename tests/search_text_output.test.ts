/** `search`'s terminal text. The summaries are FORMAT-DERIVED from `SearchExecutionSummary` and `FusedSearchResult` in src/search/types.ts; every expected line is HAND-DERIVED from the rows written here. */
import { describe, expect, it } from 'vitest'

import { formatSearchText } from '../src/search/search_cli.js'
import type { FusedSearchResult, SearchExecutionSummary } from '../src/search/types.js'

const hit = (over: Partial<FusedSearchResult>): FusedSearchResult => ({ filePath: 'src/worker.ts', lineStart: 12, lineEnd: 12, preview: '', channels: ['text'], score: 0.0328, channelHits: [], ...over })

const summary = (results: FusedSearchResult[], over: Partial<SearchExecutionSummary> = {}): SearchExecutionSummary => ({
  query: 'drain queue',
  durationMs: 42,
  totalHits: results.length,
  activeChannels: ['symbol', 'heading', 'text', 'semantic'],
  channelCounts: { symbol: 1, heading: 0, text: 3, semantic: 2 },
  results,
  ...over,
})

describe('formatSearchText', () => {
  it('prints one header line and two lines per hit, naming the agreeing channels and never the fusion score', () => {
    const text = formatSearchText(summary([
      hit({ name: 'runWorker', kind: 'function', lineStart: 12, lineEnd: 30, channels: ['symbol', 'text'], preview: 'export async function runWorker(\n  opts' }),
      hit({ filePath: 'README.md', lineStart: 4, lineEnd: 4, channels: ['semantic'], preview: '  \n ' }),
    ]))
    expect(text.split('\n')).toEqual([
      '2 results for "drain queue" in 42ms [symbol:1, heading:0, text:3, semantic:2]',
      '1. src/worker.ts:12-30 (runWorker · function) symbol+text',
      '   export async function runWorker(   opts',
      '2. README.md:4 semantic',
    ])
    expect(text).not.toContain('0.0328')
  })

  it('points at the matched line of a wide hit and keeps its span beside the name', () => {
    const text = formatSearchText(summary([hit({ name: 'drain', kind: 'function', lineStart: 10, lineEnd: 40, matchLine: 22, preview: 'function drain() {', matchPreview: '  queue.shift()' })]))
    expect(text.split('\n').slice(1)).toEqual(['1. src/worker.ts:22 (drain · function 10-40) text', '   queue.shift()'])
  })

  it('appends each degraded channel on its own line under the header', () => {
    const text = formatSearchText(summary([hit({})], { degradedChannels: [{ channel: 'semantic', reason: 'no embeddings yet' }] }))
    expect(text.split('\n').slice(0, 3)).toEqual([
      '1 result for "drain queue" in 42ms [symbol:1, heading:0, text:3, semantic:2]',
      '(note: semantic channel degraded: no embeddings yet)',
      '1. src/worker.ts:12 text',
    ])
  })

  it('says which channels it searched when nothing matched', () => {
    expect(formatSearchText(summary([], { activeChannels: ['symbol', 'text'] }))).toBe('No results found across active channels [symbol, text] for: "drain queue" (42ms)')
  })
})
