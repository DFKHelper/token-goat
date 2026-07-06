import { describe, expect, it } from 'vitest';
import { queryCsv, formatCsvTable } from '../src/csv_query.js';

const CSV = `id,name,status
1,Alice,active
2,Bob,inactive
3,Carol,active
4,Dave,inactive
`;

describe('queryCsv', () => {
  it('returns all columns and rows when no options given', () => {
    const result = queryCsv(CSV, {});
    expect(result.header).toEqual(['id', 'name', 'status']);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toEqual(['1', 'Alice', 'active']);
    expect(result.totalRows).toBe(4);
  });

  it('projects a subset of columns', () => {
    const result = queryCsv(CSV, { columns: ['name', 'status'] });
    expect(result.header).toEqual(['name', 'status']);
    expect(result.rows[0]).toEqual(['Alice', 'active']);
  });

  it('filters rows by equality', () => {
    const result = queryCsv(CSV, { whereColumn: 'status', whereValue: 'active' });
    expect(result.totalRows).toBe(2);
    expect(result.rows.map((r) => r[1])).toEqual(['Alice', 'Carol']);
  });

  it('limits rows with head while reporting the real total', () => {
    const result = queryCsv(CSV, { head: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.totalRows).toBe(4);
  });

  it('throws on an unknown projected column', () => {
    expect(() => queryCsv(CSV, { columns: ['nope'] })).toThrow(/unknown column: nope/);
  });

  it('throws on an unknown where column', () => {
    expect(() => queryCsv(CSV, { whereColumn: 'nope', whereValue: 'x' })).toThrow(/unknown column: nope/);
  });
});

describe('formatCsvTable', () => {
  it('formats header + rows as CSV lines', () => {
    const result = queryCsv(CSV, { columns: ['id', 'status'] });
    const text = formatCsvTable(result);
    expect(text.split('\n')[0]).toBe('id,status');
    expect(text).toContain('1,active');
  });

  it('appends an elision note when rows were truncated by head', () => {
    const result = queryCsv(CSV, { head: 1 });
    const text = formatCsvTable(result);
    expect(text).toContain('3 more rows elided');
  });

  it('omits the elision note when nothing was truncated', () => {
    const result = queryCsv(CSV, {});
    const text = formatCsvTable(result);
    expect(text).not.toContain('elided');
  });

  it('quotes cells containing commas, double quotes, or newlines per RFC 4180', () => {
    const csvWithSpecialChars = `id,name,note
1,"Smith, John","He said ""hi"""
2,Bob,"Line 1
Line 2"`;
    const result = queryCsv(csvWithSpecialChars, {});
    const text = formatCsvTable(result);
    const lines = text.split('\n');
    // Header should not be quoted (no special chars)
    expect(lines[0]).toBe('id,name,note');
    // First data row: comma in "Smith, John" should be quoted, quote in note should be escaped
    expect(lines[1]).toContain('"Smith, John"');
    expect(lines[1]).toContain('"He said ""hi"""');
    // Verify round-trip: the formatted CSV should be parseable
    const reparsed = queryCsv(text, {});
    expect(reparsed.rows[0]).toEqual(['1', 'Smith, John', 'He said "hi"']);
    // Second row with embedded newline
    expect(reparsed.rows[1][1]).toBe('Bob');
    expect(reparsed.rows[1][2]).toContain('Line 1');
    expect(reparsed.rows[1][2]).toContain('Line 2');
  });
});
