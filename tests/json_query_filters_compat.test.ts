// HAND-DERIVED: documents are a few rows written for this file. The expectations in the first and the deviations describes are the result the grammar before filters existed (base e67dddc6a, run on the same document and query) gave, recorded by hand, except the one case marked as a former error; the rest are worked out by hand from the help text. Notice wording is asserted by the facts it carries.

import { describe, expect, it } from 'vitest'

import { noMatchMessage, parseJsonPath, queryJson } from '../src/json_query.js'

function ids(doc: unknown, query: string): unknown[] {
  return queryJson(doc, query).items
}

describe('a bracket the grammar accepted before filters existed keeps its meaning', () => {
  it('reads a value holding && as that text', () => {
    // Base: items [1] for both.
    expect(ids({ items: [{ id: 1, name: 'a&&b' }, { id: 2, name: 'a' }] }, 'items[name=a&&b].id')).toEqual([1])
    expect(ids({ steps: [{ id: 1, run: 'npm ci && npm test' }, { id: 2, run: 'npm ci' }] }, 'steps[run=npm ci && npm test].id')).toEqual([1])
  })

  it('reads a value holding || as that text', () => {
    expect(ids({ items: [{ id: 1, name: 'a||b' }, { id: 2, name: 'a' }] }, 'items[name=a||b].id')).toEqual([1])
  })

  it('reads a key holding an operator character as that key', () => {
    expect(ids({ items: [{ id: 1, 'a<b': 1 }, { id: 2, 'a<b': 2 }] }, 'items[a<b=1].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'price$': 7 }, { id: 2, 'price$': 8 }] }, 'items[price$=7].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'price$': 7 }, { id: 2, 'price$': 8 }] }, 'items[price$="7"].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'n*': 'x' }, { id: 2, 'n*': 'y' }] }, 'items[n*=x].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'n^': 'x' }, { id: 2, 'n^': 'y' }] }, 'items[n^=x].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 't~': 'x' }, { id: 2, 't~': 'y' }] }, 'items[t~=x].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'a!b': 1 }, { id: 2, 'a!b': 2 }] }, 'items[a!b=1].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'a&&b': 1 }, { id: 2, 'a&&b': 2 }] }, 'items[a&&b=1].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, '@type': 'P' }, { id: 2, '@type': 'Q' }] }, 'items[@type=P].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, '@': 'x' }, { id: 2, '@': 'y' }] }, 'items[@=x].id')).toEqual([1])
  })

  it('keeps a key ending in * ^ $ or ~ an equality when a second = follows', () => {
    // Base: [1] for every query here.
    const star = { items: [{ id: 1, 'n*': 'x' }, { id: 2, 'n*': 'y' }, { id: 3, n: 'x' }] }
    expect(ids(star, 'items[n*==x].id')).toEqual([1])
    expect(ids(star, 'items[n*=="x"].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'price$': 7 }, { id: 2, 'price$': 8 }, { id: 3, price: 7 }] }, 'items[price$==7].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'n^': 'x' }, { id: 2, 'n^': 'y' }, { id: 3, n: 'x' }] }, 'items[n^==x].id')).toEqual([1])
  })

  it('keeps a key ending in * ^ or $ an equality on the empty text', () => {
    // Base: [1] for every query here; the key equals "".
    expect(ids({ items: [{ id: 1, 'price$': '' }, { id: 2, 'price$': 'a' }, { id: 3, price: '' }] }, 'items[price$=].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'n*': '' }, { id: 2, 'n*': 'a' }, { id: 3, n: '' }] }, 'items[n*=].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, 'n^': '' }, { id: 2, 'n^': 'a' }] }, 'items[n^= ].id')).toEqual([1])
  })

  it('keeps a key ending in ~ an equality, quoted value or not', () => {
    // Base: [1] for every query here.
    const rows = { items: [{ id: 1, 'x~': 'y' }, { id: 2, 'x~': 'z' }, { id: 3, x: 'y' }] }
    expect(ids(rows, 'items[x~="y"].id')).toEqual([1])
    expect(ids(rows, "items[x~='y'].id")).toEqual([1])
    expect(ids(rows, "items[x~=='y'].id")).toEqual([1])
  })

  it('keeps an operator character alone as the key', () => {
    // Base: [1].
    expect(ids({ items: [{ id: 1, '*': 'x' }, { id: 2, '*': 'y' }] }, 'items[*=x].id')).toEqual([1])
  })

  it('reads a value holding = < > or ? as text', () => {
    expect(ids({ items: [{ id: 1, k: 'b=c' }, { id: 2, k: 'b' }] }, 'items[k=b=c].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, tag: '<b>' }, { id: 2, tag: 'b' }] }, 'items[tag=<b>].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, u: 'http://a?x=1' }, { id: 2, u: 'b' }] }, 'items[u=http://a?x=1].id')).toEqual([1])
    expect(ids({ items: [{ id: 1, k: 'foo i' }, { id: 2, k: 'foo' }] }, 'items[k=foo i].id')).toEqual([1])
  })

  it('keeps the other spellings of one equality', () => {
    const rows = { items: [{ id: 1, k: 'v', x: 1, price: 5, p: { s: 'x' } }, { id: 2, k: 'w', x: 2, price: 6, p: { s: 'y' } }] }
    expect(ids(rows, 'items[x==1].id')).toEqual([1])
    expect(ids(rows, 'items[k="v"].id')).toEqual([1])
    expect(ids(rows, 'items[ k = v ].id')).toEqual([1])
    expect(ids(rows, 'items[?(@.price=5)].id')).toEqual([1])
    expect(ids(rows, 'items[@.k=v].id')).toEqual([1])
    expect(ids(rows, 'items[p.s=x].id')).toEqual([1])
  })

  it('still lets the object-keyed equality read as before on an object value', () => {
    // Base threw "Cannot convert object to primitive value" on this document; it is now a plain no match for that row.
    expect(ids({ rows: [{ id: 1, m: { toString: 1 } }, { id: 2, m: 'x' }] }, 'rows[m=x].id')).toEqual([2])
  })
})

describe('a combination still splits when every piece is a test of its own', () => {
  const doc = { items: [{ id: 1, status: 'active', stock: 3 }, { id: 2, status: 'active', stock: 0 }, { id: 3, status: 'gone', stock: 9 }] }

  it('combines with && and ||', () => {
    expect(ids(doc, 'items[status=active && stock>0].id')).toEqual([1])
    expect(ids(doc, 'items[status=gone || stock=0].id')).toEqual([2, 3])
  })

  it('reads the same text as a value once it is quoted', () => {
    const rows = { items: [{ id: 1, run: 'make && CC=gcc make' }, { id: 2, run: 'make' }] }
    expect(ids(rows, 'items[run="make && CC=gcc make"].id')).toEqual([1])
  })
})

describe('the declared changes from the grammar before filters existed', () => {
  // Each query below meant something else (the base result is in the comment) and now reads as the new grammar; the CHANGELOG states the rule.
  it('splits a value whose && or || pieces each look like a test', () => {
    // Base: [1] (the whole text is the value).
    expect(ids({ items: [{ id: 1, run: 'make && CC=gcc make' }, { id: 2, run: 'make' }, { id: 3, CC: 'gcc', run: 'make' }] }, 'items[run=make && CC=gcc make].id')).toEqual([])
    // Base: [1].
    expect(ids({ rows: [{ id: 1, msg: 'hi && !important' }, { id: 2, msg: 'hi' }, { id: 5, msg: 'x' }] }, 'rows[msg=hi && !important].id')).toEqual([2])
    // Base: [1].
    expect(ids({ rows: [{ id: 1, title: 'Q&A || FAQ=1' }, { id: 2, title: 'Q&A' }, { id: 3, FAQ: 1 }] }, 'rows[title=Q&A || FAQ=1].id')).toEqual([2, 3])
  })

  it('refuses text after a closing quote', () => {
    // Base: [2] (the value is `"Hello" world`, quotes included).
    const rows = { items: [{ id: 1, k: 'Hello world' }, { id: 2, k: '"Hello" world' }, { id: 3, k: 'Hello' }] }
    expect(() => queryJson(rows, 'items[k="Hello" world].id')).toThrow(/only a lowercase i may follow a quoted value/)
  })

  it('reads a trailing i after a quoted value as the case-insensitive flag', () => {
    // Base: [3] (the value is `"bob" i`, quotes included).
    const rows = { items: [{ id: 1, name: 'bob' }, { id: 2, name: 'BOB' }, { id: 3, name: '"bob" i' }] }
    expect(ids(rows, 'items[name="bob" i].id')).toEqual([1, 2])
  })
})

describe('a comparison never throws on a value it cannot order', () => {
  const doc = { items: [{ id: 1, meta: { a: 1 }, list: [1, 2] }, { id: 2, meta: 'x', list: 'y' }] }

  it('compares an object or array as no match for every operator', () => {
    for (const op of ['<', '<=', '>', '>=', '=', '!=', '*=', '^=', '$=']) {
      expect(() => queryJson(doc, `items[meta${op}x].id`), op).not.toThrow()
      expect(() => queryJson(doc, `items[list${op}1].id`), op).not.toThrow()
    }
    expect(ids(doc, 'items[meta>=x].id')).toEqual([2])
    expect(ids(doc, 'items[list*=y].id')).toEqual([2])
  })

  it('reads @ over an object element as no match', () => {
    expect(() => queryJson(doc, 'items[@>3].id')).not.toThrow()
    expect(() => queryJson(doc, 'items[@*=a].id')).not.toThrow()
    expect(ids(doc, 'items[@>3].id')).toEqual([])
  })

  it('does not throw on an object whose own toString is hostile', () => {
    const hostile = { items: [{ id: 1, v: { toString: 1 } }] }
    expect(() => queryJson(hostile, 'items[v=x].id')).not.toThrow()
    expect(() => queryJson(hostile, 'items[v*=x].id')).not.toThrow()
    expect(() => queryJson(hostile, 'items[v>x].id')).not.toThrow()
  })
})

describe('a presence test on a key that is not a plain name', () => {
  const doc = { rows: [{ id: 1, 'first-name': 'ann' }, { id: 2 }] }

  it('works through a quoted key', () => {
    expect(ids(doc, 'rows[@."first-name"].id')).toEqual([1])
    expect(ids(doc, 'rows[!"first-name"].id')).toEqual([2])
  })

  it('says so when the key is unquoted', () => {
    expect(() => parseJsonPath('rows[first-name]')).toThrow(/in quotes/)
  })
})

describe('the hints name only what is true', () => {
  const doc = { items: [{ id: 1, name: 'a', status: 'x' }, { id: 2, name: 'b', status: 'y' }], obj: { name: 'z' }, text: 'hello world' }

  it('gives the chaining advice after a filter and not after a plain step', () => {
    const after = noMatchMessage('items[id=1][name=b]', queryJson(doc, 'items[id=1][name=b]'))
    expect(after).toMatch(/second bracket after a filter/)
    for (const spec of ['obj[name=zz]', 'text[name=zz]']) {
      expect(noMatchMessage(spec, queryJson(doc, spec)), spec).not.toMatch(/second bracket after a filter/)
    }
  })

  it('says to quote a value that starts with a comparison character', () => {
    expect(() => parseJsonPath('items[id>=<5]')).toThrow(/quote the value/)
    expect(() => parseJsonPath('items[id!=<5]')).toThrow(/quote the value/)
  })

  it('names the lowercase i when the flag is spelled otherwise', () => {
    expect(() => parseJsonPath('items[name="plain" I]')).toThrow(/lowercase i/)
  })

  it('echoes a document value into a notice only when it is plain', () => {
    const sentence = { items: [{ id: 1, status: 'a plain sentence with spaces' }] }
    const msg = noMatchMessage('items[status=zz]', queryJson(sentence, 'items[status=zz]'))
    expect(msg).not.toContain('a plain sentence with spaces')
    const token = { items: [{ id: 1, status: 'active' }] }
    expect(noMatchMessage('items[status=zz]', queryJson(token, 'items[status=zz]'))).toContain('active')
  })
})
