/** A text hit used to attach to the first symbol cluster within five lines and widen it, so a `class Widget` (lines 1-3) sitting just above `function format` (5-9) swallowed format's definition hit and printed as `class 1-9`. The hit now joins the tightest symbol that contains its line (else the nearest within the slack window) and a symbol's span is never grown from the slack. Provenance: HAND-DERIVED for the hit lists (spans follow from a source where Widget is lines 1-3 and format is 5-9); CAPTURE for the shape: the hits mirror a real `search "widget format"` run in a scratch project, which printed Widget as 1-8 before the fix and 1-3 after. */

import { describe, expect, it } from 'vitest'

import { fuseChannelHits } from '../src/search/rrf.js'
import type { ChannelHit, SearchChannel } from '../src/search/types.js'

describe('search fusion attaches a text hit to the tightest cluster', () => {
  it('does not stretch the neighbouring class over a chunk that reaches into the next function', () => {
    const map = new Map<SearchChannel, ChannelHit[]>()
    map.set('symbol', [
      { channel: 'symbol', filePath: 'w.ts', name: 'Widget', kind: 'class', lineStart: 1, lineEnd: 3, preview: 'class Widget', rank: 1 },
      { channel: 'symbol', filePath: 'w.ts', name: 'format', kind: 'function', lineStart: 5, lineEnd: 9, preview: 'function format', rank: 2 },
    ])
    map.set('semantic', [{ channel: 'semantic', filePath: 'w.ts', lineStart: 1, lineEnd: 9, preview: 'chunk', rank: 1 }])
    const fused = fuseChannelHits(map, { limit: 10 })
    const spans = fused.map((r) => [r.name, r.lineStart, r.lineEnd])
    expect(spans).toEqual(expect.arrayContaining([['Widget', 1, 3], ['format', 5, 9]]))
  })

  it('prefers the containing symbol over an earlier one whose slack window also reaches the hit', () => {
    const map = new Map<SearchChannel, ChannelHit[]>()
    map.set('symbol', [
      { channel: 'symbol', filePath: 'w.ts', name: 'Widget', kind: 'class', lineStart: 1, lineEnd: 3, preview: 'class Widget', rank: 2 },
      { channel: 'symbol', filePath: 'w.ts', name: 'format', kind: 'function', lineStart: 5, lineEnd: 9, preview: 'function format', rank: 1 },
    ])
    map.set('text', [{ channel: 'text', filePath: 'w.ts', lineStart: 5, lineEnd: 5, preview: 'function format', rank: 1 }])
    const fused = fuseChannelHits(map, { limit: 10 })
    const byName = new Map(fused.map((r) => [r.name, r]))
    expect([byName.get('Widget')?.lineStart, byName.get('Widget')?.lineEnd]).toEqual([1, 3])
    expect(byName.get('Widget')?.channels).toEqual(['symbol'])
    expect(byName.get('format')?.channels.slice().sort()).toEqual(['symbol', 'text'])
  })
})
