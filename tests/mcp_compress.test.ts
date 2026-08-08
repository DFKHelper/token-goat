import { describe, it, expect } from 'vitest'

import { compressMcpResult, MCP_COMPRESS_MIN_BYTES } from '../src/mcp_compress.js'

/** Build a homogeneous array of `n` objects, each with the given key/value shape. */
function homogeneousRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    status: 'active',
    url: `https://example.com/item-${i}`,
  }))
}

describe('compressMcpResult', () => {
  it('returns null for non-JSON text', () => {
    expect(compressMcpResult('not json at all, just prose text repeated many times over')).toBeNull()
  })

  it('returns null for a JSON value that is not an array', () => {
    expect(compressMcpResult(JSON.stringify({ a: 1, b: 2 }))).toBeNull()
  })

  it('returns null for an array below the minimum row count', () => {
    expect(compressMcpResult(JSON.stringify(homogeneousRows(2)))).toBeNull()
  })

  it('returns null for an array of primitives, not objects', () => {
    expect(compressMcpResult(JSON.stringify(['a', 'b', 'c', 'd', 'e']))).toBeNull()
  })

  it('returns null when elements do not share an identical key set', () => {
    const rows = homogeneousRows(5)
    delete (rows[2] as Record<string, unknown>)['url']
    expect(compressMcpResult(JSON.stringify(rows))).toBeNull()
  })

  it('compresses a large homogeneous array into a tab-delimited table with a constant line', () => {
    const rows = homogeneousRows(50)
    const text = JSON.stringify(rows)
    const compressed = compressMcpResult(text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      // `status` is identical on every row -- pulled into the constant line, not repeated per row.
      expect(compressed).toContain('constant: status=active')
      expect(compressed).not.toContain('"status"')
      // Header row names only the variable columns.
      const lines = compressed.split('\n')
      expect(lines[1]).toBe('id\tname\turl')
      // One data row per input element, plus the constant line and the header.
      expect(lines.length).toBe(rows.length + 2)
      // Genuinely smaller than the original JSON.
      expect(compressed.length).toBeLessThan(text.length)
    }
  })

  it('returns null when every field is identical across every row (nothing to table-ify)', () => {
    const rows = Array.from({ length: 10 }, () => ({ status: 'ok', kind: 'ping' }))
    expect(compressMcpResult(JSON.stringify(rows))).toBeNull()
  })

  it('exports a positive minimum-byte threshold for callers to gate on', () => {
    expect(MCP_COMPRESS_MIN_BYTES).toBeGreaterThan(0)
  })

  it('sanitizes embedded tabs/newlines in a cell value so the row count stays one-per-element (regression: cellText used to pass string values through unescaped, so a literal \\t shifted later columns out of alignment with the header and a literal \\n split into extra unindexed lines that read as additional table rows with no data in the other columns)', () => {
    const rows = homogeneousRows(50).map((r, i) => (i === 3 ? { ...r, name: 'line1\nline2\tline3' } : r))
    const compressed = compressMcpResult(JSON.stringify(rows))
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      const lines = compressed.split('\n')
      // constant line + header + one line per row, no extra lines from the embedded newline.
      expect(lines.length).toBe(rows.length + 2)
      // The offending row's cell no longer contains a raw tab or newline.
      const offendingLine = lines.find((l) => l.includes('line1'))
      expect(offendingLine).toBe('3\tline1 line2 line3\thttps://example.com/item-3')
    }
  })

  it('sanitizes an embedded tab/newline in a JSON object key, not just cell values (regression: variableCols.join and the constant: line rendered key names raw, so a key containing a literal tab/newline would misalign the header the same way an unsanitized value did)', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      'na\tme': `item-${i}`,
      'sta\nus': 'active',
      url: `https://example.com/item-${i}`,
    }))
    const compressed = compressMcpResult(JSON.stringify(rows))
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      const lines = compressed.split('\n')
      expect(lines[0]).toBe('constant: sta us=active')
      expect(lines[1]).toBe('na me\turl')
      expect(lines.length).toBe(rows.length + 2)
    }
  })
})

describe('compressMcpResult -- empty-value pruning path', () => {
  it('drops null, empty string, empty array, and empty object values from a large nested object and appends a summary line', () => {
    const payload = {
      id: 'resource-123',
      description: null,
      subtitle: null,
      summary: null,
      owner: null,
      parent: null,
      tags: [],
      labels: [],
      categories: [],
      metadata: {},
      settings: {},
      title: '',
      notes: '',
      nested: {
        a: null,
        b: 'kept-value',
        c: { d: null, e: [] },
        f: [null, '', {}, []],
      },
    }
    const text = JSON.stringify(payload)
    const compressed = compressMcpResult(text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('"description"')
      expect(compressed).not.toContain('"tags"')
      expect(compressed).not.toContain('"metadata"')
      expect(compressed).not.toContain('"title"')
      expect(compressed).toContain('"b":"kept-value"')
      expect(compressed).toContain('resource-123')
      // Nested container that becomes empty after its own children are dropped collapses too (fixed point).
      expect(compressed).not.toContain('"c"')
      expect(compressed).not.toContain('"f"')
      // Visibility: a one-line summary naming what was removed.
      const lastLine = compressed.split('\n').at(-1)
      expect(lastLine).toMatch(/dropped \d+ empty value/)
      expect(compressed.length).toBeLessThan(text.length)
    }
  })

  it('preserves 0 and false -- they are meaningful values, not emptiness', () => {
    const payload = {
      id: 'resource-456',
      count: 0,
      enabled: false,
      description: null,
      subtitle: null,
      summary: null,
      owner: null,
      parent: null,
      tags: [],
      labels: [],
      categories: [],
      metadata: {},
      settings: {},
      empty: '',
      notes: '',
    }
    const text = JSON.stringify(payload)
    const compressed = compressMcpResult(text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).toContain('"count":0')
      expect(compressed).toContain('"enabled":false')
      expect(compressed).not.toContain('"description"')
      expect(compressed).not.toContain('"empty"')
    }
  })

  it('returns null when nothing droppable is present, even for a large object payload (no fake savings from re-serializing whitespace)', () => {
    const payload = {
      id: 'resource-789',
      count: 42,
      enabled: true,
      description: 'a real value',
      filler: 'z'.repeat(2500),
    }
    const text = JSON.stringify(payload)
    expect(compressMcpResult(text)).toBeNull()
  })

  it('returns null when pruning does not meet the net-savings ratio', () => {
    const payload = { id: 'x', description: null }
    const text = JSON.stringify(payload)
    expect(compressMcpResult(text)).toBeNull()
  })

  it('prunes an array-rooted payload the same way as an object-rooted one (elements have mismatched key sets, so the table pass rejects the shape and defers to prune-empty)', () => {
    const payload = [
      { id: 1, note: null, tags: [], owner: null, meta: {} },
      { id: 2, note: 'kept', tags: [], owner: null, meta: {}, extra: null },
      { id: 3, note: null, tags: ['x'], owner: null, meta: {} },
      { id: 4, note: null, tags: [], owner: null, meta: {} },
      { id: 5, note: null, tags: [], owner: null, meta: {} },
      { id: 6, note: null, tags: [], owner: null, meta: {} },
    ]
    const text = JSON.stringify(payload)
    const compressed = compressMcpResult(text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('"note":null')
      expect(compressed).toContain('kept')
      expect(compressed).toMatch(/dropped \d+ empty value/)
    }
  })

  it('does not recurse unbounded on a pathologically deep payload -- bails to null instead of blowing the stack', () => {
    // Built via string concatenation (not JSON.stringify on a nested object) so the test itself
    // does not depend on the native stringifier's own recursion depth, only on compressMcpResult's.
    const depth = 5000
    const text = '{"child":'.repeat(depth) + '{"value":null}' + '}'.repeat(depth)
    expect(() => compressMcpResult(text)).not.toThrow()
  })

  it('leaves the table path unaffected: an existing table-shaped payload compresses identically before and after the empty-pruning path was added', () => {
    const rows = homogeneousRows(50)
    const text = JSON.stringify(rows)
    const compressed = compressMcpResult(text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      const lines = compressed.split('\n')
      expect(lines[0]).toBe('constant: status=active')
      expect(lines[1]).toBe('id\tname\turl')
      expect(lines.length).toBe(rows.length + 2)
    }
  })
})
