/**
 * Regression: the bounds on a JSON path query must bound the QUERY, and exhausting one must never look like an honest answer.
 *
 * Three of these are one bug class -- a bound is not a bound when the document controls whether the check is reached, or how many times the bounded operation runs. Two more, covered further down, are the same failure wearing a different hat: a query that answers confidently about something it never actually evaluated. `[price>=10]` was absorbed into a field named `price>` and returned an empty filter rather than refusing an operator this grammar does not implement, and a filter field was resolved through the prototype chain, so an inherited key answered as though the object had it.
 *
 * 1. `collectRecursiveKey` held its 50,000-node ceiling in a local, and `evalJsonPath` calls it once per item already fanned out. A spec with two recursive segments therefore spent 50,000 nodes PER item of the first segment's result. Measured before the fix on a 532,931-byte document: `..a..a..blob` walked to 408,510 collected items in 9,180 ms -- eight times the ceiling the constant claims, from a file a third of a megabyte.
 * 2. Exhausting that ceiling returned whatever had been collected so far, with no signal. A truncated answer that is byte-identical to a complete one is a wrong answer: measured, a document with 60,000 targets returned 49,998 of them and the envelope said nothing. `--json` already prints a `truncated` field for its own `--head` cap, so the caller had every reason to read its absence as "this is all of them".
 * 3. `MAX_RECURSIVE_DEPTH` behaved the same way: a target nested 150 deep returned `items: []`, which is exactly what a spelling mistake returns. Measured: depth 50 found it, depth 150 reported nothing at all.
 * A fourth was considered and rejected on the evidence: a ceiling on the result list itself. It is not needed and it is not free. `..key` pushes at most once per node it visits, so a recursive result is already bounded by the node budget, and `[*]` yields references into a document that is already parsed and in memory, so a fan-out cannot be longer than that document's own node count. Capping it only broke the guarantee `tests/json_query.test.ts` pins, that a wildcard over a 200,000-element array returns all 200,000.
 *
 * The fix threads one budget through the whole evaluation and sets `truncated` whenever either ceiling bites. These tests are written against the exported constants rather than literal numbers so raising a ceiling does not require editing an assertion, but the fixtures are sized from the constants at run time, so a ceiling raised past what the fixture reaches would empty the test into a silent pass -- each exhaustion test therefore also asserts the un-truncated control case really is un-truncated.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MAX_RECURSIVE_DEPTH, MAX_RECURSIVE_NODES, queryJson } from '../src/json_query.js'
import { runCli } from './helpers/bundle.js'

/** HAND-DERIVED: a balanced tree of `{ a: [...], blob: n }` nodes, counted independently of the walker -- `nodesPerBranch` objects per branch, `branches` branches, so the node total is the product plus the root. Nothing here is read off collectRecursiveKey. */
function branchingDoc(branches: number, nodesPerBranch: number): unknown {
  const mk = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ a: [], blob: i }))
  return { a: Array.from({ length: branches }, () => ({ a: mk(nodesPerBranch) })) }
}

/** HAND-DERIVED: `depth` nested `{ a: ... }` wrappers around a single `{ blob: 'deep' }` leaf. */
function deepDoc(depth: number): unknown {
  let node: unknown = { blob: 'deep' }
  for (let i = 0; i < depth; i++) node = { a: node }
  return node
}

describe('the recursive-descent budget is spent per query, not per fanned-out item', () => {
  it('does not multiply its own ceiling by the width of an earlier segment', () => {
    // Eight branches, each big enough on its own to be a fair share of the ceiling. Pre-fix each branch got a FRESH 50,000 nodes, so the collected total ran to roughly 8x what the constant allows; post-fix the eight share one budget.
    const branches = 8
    const doc = branchingDoc(branches, Math.ceil(MAX_RECURSIVE_NODES / 4))

    // `a[*]` fans to the eight branches by plain traversal, then ONE recursive segment runs once per branch. Pre-fix each of those eight calls opened a fresh 50,000-node budget; post-fix the eight share one.
    const res = queryJson(doc, 'a[*]..blob')

    // The discriminating assertion: whatever comes back, the work behind it was capped once for the whole query.
    expect(res.items.length).toBeLessThanOrEqual(MAX_RECURSIVE_NODES)
    expect(res.truncated).toBe(true)
  })

  it('says so when it stops early instead of returning a short list that reads as complete', () => {
    const doc = branchingDoc(1, MAX_RECURSIVE_NODES * 2)

    const res = queryJson(doc, '..blob')

    // Calibration: it really did collect, so this is a statement about a truncated answer and not about a query that matched nothing.
    expect(res.items.length).toBeGreaterThan(1000)
    // Pre-fix this field did not exist, and the caller could not tell this list from every `blob` in the document.
    expect(res.truncated).toBe(true)
  })

  it('leaves an answer that fits well inside the ceiling unmarked', () => {
    // The other half of the discrimination. A `truncated: true` stamped on every recursive query would pass both tests above and tell the caller nothing.
    const res = queryJson(branchingDoc(2, 10), '..blob')

    expect(res.items.length).toBe(20)
    expect(res.truncated).toBeFalsy()
  })
})

describe('the depth ceiling reports itself rather than reporting no match', () => {
  it('marks a document deeper than the ceiling as truncated', () => {
    const res = queryJson(deepDoc(MAX_RECURSIVE_DEPTH + 50), '..blob')

    // Pre-fix: `items: []` and nothing else -- the same bytes a misspelled key returns.
    expect(res.items).toEqual([])
    expect(res.truncated).toBe(true)
  })

  it('finds the same leaf, unmarked, when it sits above the ceiling', () => {
    // Calibration for the test above: the fixture shape is findable, so the empty result there is the depth ceiling and not a broken fixture.
    const res = queryJson(deepDoc(MAX_RECURSIVE_DEPTH - 10), '..blob')

    expect(res.items).toEqual(['deep'])
    expect(res.truncated).toBeFalsy()
  })
})

describe('a comparison operator this grammar does not implement is refused, not absorbed', () => {
  // The grammar is equality-only by design. The bracket parser matched `^([^=]+)==?(.*)$`, so on `price>=10` the greedy field group swallowed the `>` and the op became a field literally named `price>`, which no document has -- an empty result, silently, for a query the user believes filtered.
  const doc = { items: [{ price: 5 }, { price: 50 }] }

  it.each([
    ['>=', 'items[price>=10]'],
    ['<=', 'items[price<=10]'],
    ['!=', 'items[price!=5]'],
  ])('refuses %s rather than returning an empty filter', (_op, spec) => {
    expect(() => queryJson(doc, spec)).toThrow(/unsupported comparison operator/)
  })

  it('still accepts the equality filter the grammar does implement', () => {
    // Calibration: the rejection above is about the operator, not about bracket filters having stopped working.
    expect(queryJson(doc, 'items[price=50]').items).toEqual([{ price: 50 }])
  })

  it('leaves a value containing an angle bracket alone', () => {
    // The check is on the field side of the first `=`, so a comparison character inside the VALUE is still just a character.
    const html = { items: [{ tag: '<b>' }, { tag: 'p' }] }
    expect(queryJson(html, 'items[tag=<b>]').items).toEqual([{ tag: '<b>' }])
  })
})

describe('a filter field names a key the object has, not one it inherits', () => {
  // Measured against the pre-fix helper, not assumed: an inherited SCALAR resolved through both branches, and an inherited OBJECT resolved through the dotted loop. `constructor.name` did NOT reproduce -- the loop's pre-existing `typeof cur !== 'object'` check already rejects `constructor`, since it is a function -- so it is not asserted here. `items[constructor=...]` is not expressible either: the value stringifies to something containing `]`, which the bracket scanner ends the segment on.

  it('does not treat a key the object inherits as one it has', () => {
    // The undotted branch tested membership with `in`, which reads the whole chain. Nothing JSON.parse produces inherits a data key, but queryJson is also the engine behind `yaml-query` and is exported for direct use, so the guard is asserted on the helper's own terms.
    const doc = { items: [Object.assign(Object.create({ role: 'admin' }), { name: 'a' })] }

    expect(queryJson(doc, 'items[role=admin]').items).toEqual([])
    // Calibration: the item is reachable and its OWN field still filters, so the empty result above is the chain being excluded and not the item being unreachable.
    expect(queryJson(doc, 'items[name=a]').items.length).toBe(1)
  })

  it('does not walk a dotted path into an inherited object', () => {
    // The dotted loop's own defect, distinct from the one above: each step was a bare property read, so only the FIRST segment had to be inherited for the whole path to resolve.
    const doc = { items: [Object.assign(Object.create({ meta: { env: 'prod' } }), { name: 'a' })] }

    expect(queryJson(doc, 'items[meta.env=prod]').items).toEqual([])
  })

  it('still resolves a genuine nested field', () => {
    // Calibration: dotted filter fields work, so the two empty results above are the prototype chain being excluded and not dotted paths having broken.
    const doc = { items: [{ meta: { env: 'prod' } }, { meta: { env: 'dev' } }] }
    expect(queryJson(doc, 'items[meta.env=prod]').items).toEqual([{ meta: { env: 'prod' } }])
  })

  it('still resolves a key whose own name contains a dot', () => {
    const doc = { items: [{ 'a.b': 'yes' }, { a: { b: 'no' } }] }
    expect(queryJson(doc, 'items[a.b=yes]').items).toEqual([{ 'a.b': 'yes' }])
  })
})

describe('the CLI passes the truncation on rather than absorbing it', () => {
  let DIR: string
  let bigFile: string
  let deepFile: string
  let smallFile: string

  beforeAll(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jsonq-bounds-'))
    bigFile = path.join(DIR, 'big.json')
    deepFile = path.join(DIR, 'deep.json')
    smallFile = path.join(DIR, 'small.json')
    fs.writeFileSync(bigFile, JSON.stringify(branchingDoc(1, MAX_RECURSIVE_NODES * 2)))
    fs.writeFileSync(deepFile, JSON.stringify(deepDoc(MAX_RECURSIVE_DEPTH + 50)))
    fs.writeFileSync(smallFile, JSON.stringify(branchingDoc(2, 10)))
  })

  afterAll(() => {
    fs.rmSync(DIR, { recursive: true, force: true })
  })

  it('reports a budget-exhausted query as truncated in --json', () => {
    // The DEEP document on purpose, not the wide one. A wide result is large enough that the envelope's own row guard sets `truncated` regardless, so this assertion would pass with the query's truncation thrown away -- it would be testing the row cap while claiming to test the query. The deep one returns zero items, which no row cap trims, so the only thing that can set the field is the query itself.
    const res = runCli(['json-query', deepFile, '..blob', '--json'])

    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { truncated?: boolean; items: unknown[] }
    expect(parsed.items).toEqual([])
    // The envelope already carried a `truncated` field for its own caps. A query stopped by its own ceilings has to reach the same field, or the field says "complete" about an empty list that is not the answer.
    expect(parsed.truncated).toBe(true)
  })

  it('leaves a query that finished as not truncated', () => {
    // Calibration: the field is not simply always true once a fan-out happens.
    const res = runCli(['json-query', smallFile, '..blob', '--json'])

    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { truncated?: boolean; items: unknown[] }
    expect(parsed.items.length).toBe(20)
    expect(parsed.truncated).toBe(false)
  })

  it('says so in the plain-text form too', () => {
    // `--head` so the assertion is about the notice and not about 50,000 lines of items. It also puts the two notices side by side: the `--head` elision is the caller asking for fewer, and this one is the query not having finished, which nothing else on screen would reveal.
    const res = runCli(['json-query', bigFile, '..blob', '--head', '3'])

    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/stopped early/i)
    expect(res.stdout).toMatch(/use --head to see more/)
  })
})
