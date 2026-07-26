import { describe, expect, it } from 'vitest';
import { outlineJson, formatJsonOutline, parseJsonPath, evalJsonPath, queryJson, jsonType } from '../src/json_query.js';

const PEOPLE = {
  items: [
    { id: 1, name: 'Alice', status: 'active', tags: ['a', 'b'] },
    { id: 2, name: 'Bob', status: 'inactive', tags: [] },
    { id: 3, name: 'Carol', status: 'active', tags: ['c'] },
  ],
};

describe('jsonType', () => {
  it('classifies null, arrays, and objects distinctly from typeof', () => {
    expect(jsonType(null)).toBe('null');
    expect(jsonType([1, 2])).toBe('array');
    expect(jsonType({ a: 1 })).toBe('object');
    expect(jsonType('x')).toBe('string');
    expect(jsonType(1)).toBe('number');
    expect(jsonType(true)).toBe('boolean');
  });
});

describe('outlineJson', () => {
  it('summarizes an array of objects with element count, dominant type, and merged key shape', () => {
    const outline = outlineJson(PEOPLE.items);
    expect(outline.kind).toBe('array');
    if (outline.kind !== 'array') throw new Error('unreachable');
    expect(outline.length).toBe(3);
    expect(outline.elementType).toBe('object');
    expect(outline.sampleKeys).toEqual(
      expect.arrayContaining([
        { name: 'id', type: 'number' },
        { name: 'name', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'tags', type: 'array', size: 2 },
      ]),
    );
    expect(outline.heterogeneous).toBe(false);
  });

  it('flags heterogeneous shape when sampled elements have different key sets', () => {
    const outline = outlineJson([{ a: 1, b: 2 }, { a: 1, c: 3 }]);
    expect(outline.kind).toBe('array');
    if (outline.kind !== 'array') throw new Error('unreachable');
    expect(outline.heterogeneous).toBe(true);
    expect(outline.sampleKeys?.map((f) => f.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports an array of scalars with elementType set and no sampleKeys', () => {
    const outline = outlineJson([1, 2, 3]);
    expect(outline.kind).toBe('array');
    if (outline.kind !== 'array') throw new Error('unreachable');
    expect(outline.elementType).toBe('number');
    expect(outline.sampleKeys).toBeUndefined();
  });

  it('reports mixed elementType for an array with heterogeneous primitive types', () => {
    const outline = outlineJson([1, 'two', true]);
    expect(outline.kind).toBe('array');
    if (outline.kind !== 'array') throw new Error('unreachable');
    expect(outline.elementType).toBe('mixed');
  });

  it('reports unknown elementType for an empty array', () => {
    const outline = outlineJson([]);
    expect(outline.kind).toBe('array');
    if (outline.kind !== 'array') throw new Error('unreachable');
    expect(outline.length).toBe(0);
    expect(outline.elementType).toBe('unknown');
  });

  it('only samples the first sampleSize elements, not the whole array', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, ...(i === 99 ? { extra: 'only-on-last' } : {}) }));
    const outline = outlineJson(arr, { sampleSize: 3 });
    expect(outline.kind).toBe('array');
    if (outline.kind !== 'array') throw new Error('unreachable');
    expect(outline.length).toBe(100);
    expect(outline.sampleKeys?.some((f) => f.name === 'extra')).toBe(false);
  });

  it('summarizes a top-level object as top-level keys with type and size', () => {
    const outline = outlineJson({ name: 'app', version: '1.0.0', deps: { a: 1, b: 2 }, items: [1, 2, 3] });
    expect(outline.kind).toBe('object');
    if (outline.kind !== 'object') throw new Error('unreachable');
    expect(outline.fields).toEqual(
      expect.arrayContaining([
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'deps', type: 'object', size: 2 },
        { name: 'items', type: 'array', size: 3 },
      ]),
    );
  });

  it('reports a top-level scalar as a primitive', () => {
    expect(outlineJson(42)).toEqual({ kind: 'primitive', type: 'number' });
    expect(outlineJson(null)).toEqual({ kind: 'primitive', type: 'null' });
  });
});

describe('formatJsonOutline', () => {
  it('renders array outline as a length/type header plus indented key lines', () => {
    const text = formatJsonOutline(outlineJson(PEOPLE.items));
    expect(text).toContain('array of 3 elements (object)');
    expect(text).toContain('id: number');
    expect(text).toContain('tags: array (2)');
  });

  it('renders object outline as one line per field', () => {
    const text = formatJsonOutline(outlineJson({ a: 1, b: [1, 2] }));
    expect(text).toContain('a: number');
    expect(text).toContain('b: array (2)');
  });

  it('renders empty object distinctly', () => {
    expect(formatJsonOutline(outlineJson({}))).toBe('(empty object)');
  });

  it('renders a scalar as (scalar TYPE)', () => {
    expect(formatJsonOutline(outlineJson('x'))).toBe('(scalar string)');
  });
});

describe('parseJsonPath', () => {
  it('parses a plain dotted key path', () => {
    expect(parseJsonPath('data.items.name')).toEqual([
      { kind: 'key', name: 'data' },
      { kind: 'key', name: 'items' },
      { kind: 'key', name: 'name' },
    ]);
  });

  it('parses an array index segment', () => {
    expect(parseJsonPath('items[3]')).toEqual([
      { kind: 'key', name: 'items' },
      { kind: 'index', index: 3 },
    ]);
  });

  it('parses a negative array index segment', () => {
    expect(parseJsonPath('items[-1]')).toEqual([
      { kind: 'key', name: 'items' },
      { kind: 'index', index: -1 },
    ]);
  });

  it('parses a wildcard segment', () => {
    expect(parseJsonPath('items[*].id')).toEqual([
      { kind: 'key', name: 'items' },
      { kind: 'wildcard' },
      { kind: 'key', name: 'id' },
    ]);
  });

  it('parses a field=value filter segment', () => {
    expect(parseJsonPath('items[status=active]')).toEqual([
      { kind: 'key', name: 'items' },
      { kind: 'filter', field: 'status', value: 'active' },
    ]);
  });

  it('parses an empty spec as no ops', () => {
    expect(parseJsonPath('')).toEqual([]);
  });

  it('throws on an unterminated bracket', () => {
    expect(() => parseJsonPath('items[3')).toThrow(/unterminated/);
  });

  it('throws on an unrecognized bracket expression', () => {
    expect(() => parseJsonPath('items[!!]')).toThrow(/invalid bracket expression/);
  });
});

describe('evalJsonPath / queryJson', () => {
  it('extracts a single scalar at a non-fanned path', () => {
    const result = queryJson(PEOPLE, 'items[0].name');
    expect(result.fanned).toBe(false);
    expect(result.items).toEqual(['Alice']);
  });

  it('extracts a nested object at a non-fanned path', () => {
    const result = queryJson(PEOPLE, 'items[1]');
    expect(result.fanned).toBe(false);
    expect(result.items).toEqual([{ id: 2, name: 'Bob', status: 'inactive', tags: [] }]);
  });

  it('returns the whole document for an empty path', () => {
    const result = queryJson(PEOPLE, '');
    expect(result.fanned).toBe(false);
    expect(result.items).toEqual([PEOPLE]);
  });

  it('projects a field across every array element with [*]', () => {
    const result = queryJson(PEOPLE, 'items[*].name');
    expect(result.fanned).toBe(true);
    expect(result.items).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('projects object values with [*] on an object', () => {
    const result = queryJson({ a: 1, b: 2, c: 3 }, '[*]');
    expect(result.fanned).toBe(true);
    expect(result.items.sort()).toEqual([1, 2, 3]);
  });

  it('filters array elements by field value with [field=value]', () => {
    const result = queryJson(PEOPLE, 'items[status=active]');
    expect(result.fanned).toBe(true);
    expect((result.items as Array<{ name: string }>).map((i) => i.name)).toEqual(['Alice', 'Carol']);
  });

  it('chains a filter with a further field projection', () => {
    const result = queryJson(PEOPLE, 'items[status=active].name');
    expect(result.fanned).toBe(true);
    expect(result.items).toEqual(['Alice', 'Carol']);
  });

  it('returns an empty fanned result when a filter matches nothing, rather than erroring', () => {
    const result = queryJson(PEOPLE, 'items[status=archived]');
    expect(result.fanned).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('drops a per-item missing key after fanning out instead of erroring on heterogeneous shapes', () => {
    const mixed = { items: [{ a: 1 }, { b: 2 }] };
    const result = queryJson(mixed, 'items[*].a');
    expect(result.fanned).toBe(true);
    expect(result.items).toEqual([1]);
  });

  it('resolves a negative index from the end of the array', () => {
    const result = queryJson(PEOPLE, 'items[-1].name');
    expect(result.items).toEqual(['Carol']);
  });

  it('throws on a missing key at a non-fanned path', () => {
    expect(() => queryJson(PEOPLE, 'items[0].doesNotExist')).toThrow(/path not found/);
  });

  it('throws on a missing key that collides with an inherited Object.prototype member', () => {
    // 'toString', 'constructor', 'hasOwnProperty', etc. are visible via the `in` operator on
    // any plain object even when absent as an own property -- a key lookup must only ever
    // succeed for a real own property, never fall through to the prototype chain.
    const data = { id: 1 };
    expect(() => queryJson(data, 'toString')).toThrow(/path not found/);
    expect(() => queryJson(data, 'constructor')).toThrow(/path not found/);
    expect(() => queryJson(data, 'hasOwnProperty')).toThrow(/path not found/);
  });

  it('throws on an out-of-range index at a non-fanned path', () => {
    expect(() => queryJson(PEOPLE, 'items[99]')).toThrow(/out of range/);
  });

  it('throws on indexing into a non-array at a non-fanned path', () => {
    expect(() => queryJson(PEOPLE, 'items[0].name[0]')).toThrow(/non-array/);
  });

  it('throws on a key lookup against a non-object at a non-fanned path', () => {
    expect(() => queryJson(PEOPLE, 'items[0].name.nested')).toThrow(/path not found/);
  });

  it('evalJsonPath accepts pre-parsed ops directly', () => {
    const ops = parseJsonPath('items[0].id');
    const result = evalJsonPath(PEOPLE, ops);
    expect(result.items).toEqual([1]);
  });
});
