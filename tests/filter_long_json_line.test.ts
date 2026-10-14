/** A JSON document printed on one line (an API response, `json.dumps` with no indent) is exactly the kind of line `capLongLines` clips, and keeping its first `maxChars` characters cuts it inside a string and drops every element after the cut. CAPTURE (recorded sessions 359bb651 seq 324, 633f771b seq 83, agent-a0 seq 79): a JSON line arrived as `"conversion_` followed by `… [2090 chars elided]`, and the next call recalled the output in full and parsed it with `json.loads`. Fixture provenance: HAND-DERIVED. The records are synthetic, sized so the line clears LONG_LINE_MAX_CHARS three times over, and each carries a distinct id so a dropped element is visible by name. */
import { describe, expect, it } from 'vitest'

import { capLongLines, FALLBACK_MAX_LINE_CHARS, LONG_LINE_MAX_CHARS } from '../src/tool_filters/helpers.js'
import { deliverCompressed, detectFromCommand } from '../src/tool_filters/dispatch.js'
import { GenericFilter } from '../src/tool_filters/generic.js'

/** One record as its producer printed it. The ids are past 2^53 and kept as text, so a JSON.parse round trip anywhere would visibly round them. */
const record = (i: number): string =>
  `{"id": 90071992547409${93 + i}, "sku": "CCC-${1000 + i}", "title": "Washi tape set ${i}, \\"pastel\\" roll", "tags": ["craft", "journal", "batch-${i}"], "price": {"amount": "4.50", "currency": "USD"}}`
// 20 records: wide enough to clear the 1,000-char cap three times, and narrow enough to stay under the 4,000-char input clip (INPUT_MAX_LINE_CHARS), which would cut a wider line in the middle before capLongLines ever sees it.
const COUNT = 20
const oneLine = '[' + Array.from({ length: COUNT }, (_, i) => record(i)).join(', ') + ']'

describe('capLongLines on a one-line JSON document', () => {
  it('puts each record on its own line, so every one keeps its first keys', () => {
    expect(oneLine.length).toBeGreaterThan(3 * LONG_LINE_MAX_CHARS)
    const out = capLongLines([oneLine], LONG_LINE_MAX_CHARS)
    expect(out).toHaveLength(COUNT + 2)
    expect(out[0]).toBe('[')
    expect(out[COUNT + 1]).toBe(']')
    for (let i = 0; i < COUNT; i++) expect(out[i + 1]).toMatch(new RegExp(`^  \\{"id":90071992547409${93 + i},"sku":"CCC-${1000 + i}",`))
    expect(out.join('\n')).not.toContain('chars elided')
  })

  it('keeps every token exactly as printed, the way a parse and re-stringify would not', () => {
    const out = capLongLines([oneLine], LONG_LINE_MAX_CHARS).join('\n')
    expect(out).toContain('"id":9007199254740993,')
    expect(out).toContain('"title":"Washi tape set 0, \\"pastel\\" roll",')
    expect(JSON.parse(out)).toEqual(JSON.parse(oneLine))
  })

  it('opens only what is too wide, with stable two-space indentation under the line\'s own indent', () => {
    const doc = '  {"a": 1, "b": [1, 2], "c": {}, "d": [], "e": [' + Array.from({ length: 200 }, (_, i) => i).join(', ') + '], "f": "' + 'x'.repeat(1200) + '"}'
    const out = capLongLines([doc], LONG_LINE_MAX_CHARS)
    expect(out.slice(0, 5)).toEqual(['  {', '    "a": 1,', '    "b": [1,2],', '    "c": {},', '    "d": [],'])
    expect(out[5]).toMatch(/^ {4}"e": \[0,1,2,.*,199\],$/)
    expect(out[out.length - 1]).toBe('  }')
    // A single value still wider than the cap has no members to open onto, so it is clipped like any other long line.
    expect(out[6]).toMatch(/^ {4}"f": "x+ {2}… \[\d+ chars elided\]$/)
  })

  it('still clips a long line that is not JSON, or is JSON cut short', () => {
    const [plain] = capLongLines(['{' + 'y'.repeat(2000)], LONG_LINE_MAX_CHARS)
    expect(plain).toContain('chars elided')
    const [broken] = capLongLines([oneLine.slice(0, -1)], LONG_LINE_MAX_CHARS)
    expect(broken).toContain('chars elided')
  })

  it('opens a record wider than the cap onto its own members', () => {
    const out = capLongLines([oneLine], FALLBACK_MAX_LINE_CHARS)
    expect(out).not.toContain('chars elided')
    expect(out.join('\n')).toContain(`"sku":"CCC-${1000 + COUNT - 1}"`)
    expect(out.every((l) => l.length <= FALLBACK_MAX_LINE_CHARS)).toBe(true)
  })

  // HAND-DERIVED adversarial shape: nesting alone, so every level is one container too wide to fit. Opened level by level it costs two spaces of indent per level on every line below it, about 2·D² characters for depth D, and one stack frame per level.
  const nested = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth)

  it('stops opening containers a few levels down, so deep nesting costs a bounded indent', () => {
    const line = nested(2000)
    expect(line.length).toBe(4000)
    const out = capLongLines([line], LONG_LINE_MAX_CHARS)
    const indent = Math.max(...out.map((l) => l.length - l.trimStart().length))
    expect(indent).toBeLessThanOrEqual(64)
    expect(out.join('\n').length).toBeLessThan(20_000)
  })

  it('lets a 500 KB deeply nested document through a whole-JSON filter without throwing', () => {
    // `gh api` parses its JSON whole, so its stdout skips the 4,000-char input clip and the line reaches the per-line cap at full width.
    const doc = nested(250_000)
    const detected = detectFromCommand('gh api repos/o/r/contents')
    expect(detected).not.toBeNull()
    const result = detected!.filter.apply(doc, '', 0, detected!.argv)
    expect(Buffer.byteLength(result.text)).toBeLessThan(70_000)
  })

  it('reaches the model with every record through the generic filter instead of head-clipped', () => {
    // A noisy run around the document, so the rewrite pays for itself and the laid-out document is what ships.
    const noise = Array.from({ length: 200 }, () => 'progress: fetching page').join('\n')
    const { applied, text } = deliverCompressed(new GenericFilter(), `${noise}\n${oneLine}\n`, '', 0, [])
    expect(applied).toBe(true)
    for (let i = 0; i < COUNT; i++) expect(text).toContain(`CCC-${1000 + i}`)
    expect(text).not.toContain('chars elided')
  })
})
