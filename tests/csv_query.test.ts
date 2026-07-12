import { describe, expect, it } from 'vitest';
import { queryCsv, formatCsvTable, parseWhereSpecs, profileCsv, formatCsvProfile } from '../src/csv_query.js';

const CSV = `id,name,status
1,Alice,active
2,Bob,inactive
3,Carol,active
4,Dave,inactive
`;

const CSV_NUM = `id,name,age
1,Alice,30
2,Bob,25
3,Carol,40
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

  // Regression: Excel/PowerShell "Save As UTF-8" on Windows (the primary platform for this
  // tool) prefixes the file with a UTF-8 BOM. Without `bom: true` on csv-parse, the
  // BOM stays glued to the first header cell (a BOM-prefixed 'id' instead of 'id'), silently breaking
  // --columns/--where lookups on that column even though the file looks fine in a text editor.
  it('strips a leading UTF-8 BOM from the first header so --columns/--where match on it', () => {
    const bomCsv = '\uFEFF' + CSV;
    const result = queryCsv(bomCsv, { columns: ['id', 'name'] });
    expect(result.header).toEqual(['id', 'name']);
    expect(result.rows[0]).toEqual(['1', 'Alice']);

    const filtered = queryCsv(bomCsv, { wheres: [{ column: 'id', op: '=', value: '1' }] });
    expect(filtered.totalRows).toBe(1);
  });

  it('filters rows by equality', () => {
    const result = queryCsv(CSV, { wheres: [{ column: 'status', op: '=', value: 'active' }] });
    expect(result.totalRows).toBe(2);
    expect(result.rows.map((r) => r[1])).toEqual(['Alice', 'Carol']);
  });

  it('filters rows by inequality', () => {
    const result = queryCsv(CSV, { wheres: [{ column: 'status', op: '!=', value: 'active' }] });
    expect(result.rows.map((r) => r[1])).toEqual(['Bob', 'Dave']);
  });

  it('filters rows by numeric comparison', () => {
    const result = queryCsv(CSV_NUM, { wheres: [{ column: 'age', op: '>', value: '28' }] });
    expect(result.rows.map((r) => r[1])).toEqual(['Alice', 'Carol']);
  });

  it('filters rows by regex', () => {
    const result = queryCsv(CSV, { wheres: [{ column: 'name', op: '~=', value: '^(A|B)' }] });
    expect(result.rows.map((r) => r[1])).toEqual(['Alice', 'Bob']);
  });

  it('ANDs multiple wheres together', () => {
    const result = queryCsv(CSV, {
      wheres: [
        { column: 'status', op: '=', value: 'active' },
        { column: 'name', op: '!=', value: 'Alice' },
      ],
    });
    expect(result.rows.map((r) => r[1])).toEqual(['Carol']);
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
    expect(() => queryCsv(CSV, { wheres: [{ column: 'nope', op: '=', value: 'x' }] })).toThrow(/unknown column: nope/);
  });

  it('supports a custom delimiter', () => {
    const tsv = 'id\tname\n1\tAlice\n2\tBob\n';
    const result = queryCsv(tsv, { delimiter: '\t' });
    expect(result.header).toEqual(['id', 'name']);
    expect(result.rows[0]).toEqual(['1', 'Alice']);
  });

  it('supports noHeader, synthesizing col1/col2/... column names', () => {
    const result = queryCsv('1,Alice\n2,Bob\n', { noHeader: true });
    expect(result.header).toEqual(['col1', 'col2']);
    expect(result.rows[0]).toEqual(['1', 'Alice']);
  });
});

describe('parseWhereSpecs', () => {
  it('returns undefined for an empty/unset list', () => {
    expect(parseWhereSpecs(undefined)).toBeUndefined();
    expect(parseWhereSpecs([])).toBeUndefined();
  });

  it('parses each supported operator', () => {
    expect(parseWhereSpecs(['status=active'])).toEqual([{ column: 'status', op: '=', value: 'active' }]);
    expect(parseWhereSpecs(['status!=active'])).toEqual([{ column: 'status', op: '!=', value: 'active' }]);
    expect(parseWhereSpecs(['age>18'])).toEqual([{ column: 'age', op: '>', value: '18' }]);
    expect(parseWhereSpecs(['age<18'])).toEqual([{ column: 'age', op: '<', value: '18' }]);
    expect(parseWhereSpecs(['name~=^A'])).toEqual([{ column: 'name', op: '~=', value: '^A' }]);
  });

  it('throws on a spec with no recognized operator', () => {
    expect(() => parseWhereSpecs(['nospec'])).toThrow(/invalid --where spec/);
  });
});

describe('profileCsv', () => {
  it('infers number/string types with null and distinct counts', () => {
    const profiles = profileCsv(CSV_NUM);
    const age = profiles.find((p) => p.name === 'age');
    expect(age).toMatchObject({ inferredType: 'number', nullCount: 0, distinctCount: 3, min: '25', max: '40' });
    const name = profiles.find((p) => p.name === 'name');
    expect(name?.inferredType).toBe('string');
  });

  it('counts nulls for empty cells', () => {
    const profiles = profileCsv('id,name\n1,Alice\n2,\n');
    const name = profiles.find((p) => p.name === 'name');
    expect(name?.nullCount).toBe(1);
  });

  it('reports top values for low-cardinality columns', () => {
    const profiles = profileCsv(CSV);
    const status = profiles.find((p) => p.name === 'status');
    expect(status?.topValues).toEqual(
      expect.arrayContaining([
        { value: 'active', count: 2 },
        { value: 'inactive', count: 2 },
      ]),
    );
  });

  it('computes min/max for numeric columns with >65k rows without RangeError', () => {
    const rows: string[] = ['id,value'];
    for (let i = 0; i < 70000; i++) {
      rows.push(`${i},${Math.floor(Math.random() * 10000)}`);
    }
    const csv = rows.join('\n');
    const profiles = profileCsv(csv);
    const valueCol = profiles.find((p) => p.name === 'value');
    expect(valueCol?.inferredType).toBe('number');
    expect(valueCol?.min).toBeDefined();
    expect(valueCol?.max).toBeDefined();
    const minNum = Number(valueCol?.min);
    const maxNum = Number(valueCol?.max);
    expect(minNum).toBeLessThanOrEqual(maxNum);
    expect(minNum).toBeGreaterThanOrEqual(0);
    expect(maxNum).toBeLessThan(10000);
  });
});

describe('formatCsvProfile', () => {
  it('renders one block per column with type, counts, and range', () => {
    const text = formatCsvProfile(profileCsv(CSV_NUM));
    expect(text).toContain('age  (number)');
    expect(text).toContain('range: 25 .. 40');
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
