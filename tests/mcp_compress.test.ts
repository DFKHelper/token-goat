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
