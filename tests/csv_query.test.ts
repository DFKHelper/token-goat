import { describe, expect, it } from 'vitest';
import { queryCsv, formatCsvTable, parseWhereSpecs, profileCsv, formatCsvProfile, quoteCsvCell } from '../src/csv_query.js';

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

  // Regression: `Number('')` is 0, not NaN, so a blank cell in a numeric column was silently
  // coerced to the literal value 0 instead of being treated as "no value". That made a blank
  // cell wrongly match `age<10` (0 < 10) and wrongly match `age>-1` (0 > -1) -- a row with no
  // age data should never satisfy either filter.
  it('excludes blank cells from a numeric comparison instead of coercing them to 0', () => {
    const csvWithBlank = `id,name,age\n1,Alice,30\n2,Blank,\n3,Carol,40\n`;

    const lt10 = queryCsv(csvWithBlank, { wheres: [{ column: 'age', op: '<', value: '10' }] });
    expect(lt10.rows.map((r) => r[1])).not.toContain('Blank');
    expect(lt10.totalRows).toBe(0);

    const gtNeg1 = queryCsv(csvWithBlank, { wheres: [{ column: 'age', op: '>', value: '-1' }] });
    expect(gtNeg1.rows.map((r) => r[1])).not.toContain('Blank');
    expect(gtNeg1.rows.map((r) => r[1])).toEqual(['Alice', 'Carol']);
  });

  it('still matches a genuinely zero-valued cell against a numeric comparison', () => {
    const csvWithZero = `id,name,age\n1,Alice,30\n2,Zero,0\n3,Carol,40\n`;
    const lt10 = queryCsv(csvWithZero, { wheres: [{ column: 'age', op: '<', value: '10' }] });
    expect(lt10.rows.map((r) => r[1])).toEqual(['Zero']);
  });

  it('filters rows by >= and <=', () => {
    const gte = queryCsv(CSV_NUM, { wheres: [{ column: 'age', op: '>=', value: '30' }] });
    expect(gte.rows.map((r) => r[1])).toEqual(['Alice', 'Carol']);

    const lte = queryCsv(CSV_NUM, { wheres: [{ column: 'age', op: '<=', value: '25' }] });
    expect(lte.rows.map((r) => r[1])).toEqual(['Bob']);
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

  it('resolves a --where spec against the correct column when a header name contains operator characters', () => {
    // Regression: WHERE_SPEC_RE's column capture excludes = < > ~ ! outright, so it always
    // splits at the FIRST operator-class character. With headers `a` and `a<b`, the spec
    // "a<b=x" naively parses as column "a", op "<", value "b=x" -- and since column "a"
    // genuinely exists, the query used to run silently against the wrong column instead of
    // targeting the real "a<b" column or erroring.
    const csv = 'a,a<b\nfoo,x\nbar,y\n';
    const wheres = parseWhereSpecs(['a<b=x']);
    const result = queryCsv(csv, { wheres });
    // Correct behavior: this targets column "a<b" with op "=" and value "x", matching only the
    // first row. The old behavior (column "a", op "<", value "b=x") would run a string
    // comparison "a" < "b=x" against both rows' "a" values ("foo" and "bar"), matching neither.
    expect(result.rows).toEqual([['foo', 'x']]);
  });

  it('resolves a --where spec against a column whose name contains a bare ! (regression: WHERE_SPEC_RE excluded ! outright from the column capture, so a spec targeting a column like wow!thing could never match at all, throwing invalid --where spec instead of querying it)', () => {
    const csv = 'name,wow!thing\nalice,5\nbob,7\n';
    const wheres = parseWhereSpecs(['wow!thing=5']);
    const result = queryCsv(csv, { wheres });
    expect(result.rows).toEqual([['alice', '5']]);
  });

  it('resolves a --where spec against a column whose name contains a bare ~ (regression: WHERE_SPEC_RE excluded ~ outright from the column capture with no !-style exemption, so a spec targeting a column like temp~F hit no valid operator match at the ~ and threw invalid --where spec instead of querying it)', () => {
    const csv = 'name,temp~F\nalice,98\nbob,70\n';
    const wheres = parseWhereSpecs(['temp~F=98']);
    const result = queryCsv(csv, { wheres });
    expect(result.rows).toEqual([['alice', '98']]);
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

  it('parses >= and <= without misreading them as > or < with a leading = in the value', () => {
    expect(parseWhereSpecs(['age>=18'])).toEqual([{ column: 'age', op: '>=', value: '18' }]);
    expect(parseWhereSpecs(['age<=18'])).toEqual([{ column: 'age', op: '<=', value: '18' }]);
  });

  it('throws on a spec with no recognized operator', () => {
    expect(() => parseWhereSpecs(['nospec'])).toThrow(/invalid --where spec/);
  });

  it('throws on a numeric comparison with a missing right-hand value instead of silently treating it as a comparison against 0 (regression: Number(\'\') === 0, so a typo like "price>" with nothing after the operator was silently accepted as "price > 0" instead of erroring)', () => {
    expect(() => parseWhereSpecs(['price>'])).toThrow(/invalid --where spec/);
    expect(() => parseWhereSpecs(['price<'])).toThrow(/invalid --where spec/);
    expect(() => parseWhereSpecs(['price>='])).toThrow(/invalid --where spec/);
    expect(() => parseWhereSpecs(['price<='])).toThrow(/invalid --where spec/);
  });

  it('still allows an empty right-hand value for non-numeric operators (= != ~=), where it is a legitimate query, not a typo', () => {
    expect(parseWhereSpecs(['name='])).toEqual([{ column: 'name', op: '=', value: '' }]);
    expect(parseWhereSpecs(['name!='])).toEqual([{ column: 'name', op: '!=', value: '' }]);
    expect(parseWhereSpecs(['name~='])).toEqual([{ column: 'name', op: '~=', value: '' }]);
  });

  it('parses a column containing a bare ! without misreading it as the start of != (regression)', () => {
    expect(parseWhereSpecs(['wow!thing=5'])).toEqual([{ column: 'wow!thing', op: '=', value: '5' }]);
  });

  it('still parses a genuine != operator on a column with no ! in its own name', () => {
    expect(parseWhereSpecs(['age!=5'])).toEqual([{ column: 'age', op: '!=', value: '5' }]);
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

  // Regression: quoteCsvCell's RFC 4180 guard only checked for '\n', so a cell containing
  // a bare '\r' (no accompanying '\n' -- old Mac-style line breaks, terminal capture paste)
  // was emitted unquoted, embedding a raw carriage return in the output that overwrites
  // the start of the terminal line when printed and is unsafe to round-trip through strict
  // RFC 4180 parsers (CR alone is a valid line break under the spec).
  it('quotes a cell containing a bare carriage return with no accompanying newline', () => {
    expect(quoteCsvCell('line1\rline2')).toBe('"line1\rline2"');
  });
});
