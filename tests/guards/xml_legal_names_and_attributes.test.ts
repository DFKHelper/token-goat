/**
 * Guard: the XML tokenizer must parse the XML the spec calls legal, not the subset a regex is
 * comfortable with.
 *
 * Two shapes of ordinary, spec-legal XML were silently mangled.
 *
 * A `>` inside a quoted attribute value is explicitly legal (only `<` and `&` are forbidden there),
 * and appears in real documents any time an attribute holds a comparison, an arrow, or a fragment of
 * markup. The tag pattern ended the element at the first `>` it saw, so `<item title="a>b" id="1">`
 * parsed as an element whose title was `"a`, whose `id` had vanished, and the rest of whose start
 * tag became text content.
 *
 * XML Names are Unicode: `<café>` and `<数据>` are as legal as `<item>`. The name class was
 * ASCII-only, so `café` was truncated to `caf` -- the element was there under a name no query would
 * ever ask for -- and `数据`, which begins with a non-ASCII character, was dropped from the tree
 * entirely along with its text, while `xml-outline` still presented its summary as complete.
 *
 * Both failures are silent, which is what makes them worth a guard: the command exits 0 and prints
 * a well-formed answer. A caller cannot tell a document that has no `id` attribute from one whose
 * `id` was eaten, or a document with two children from one with three.
 *
 * Why didn't a test catch this: every fixture in `tests/xml_query.test.ts` is ASCII, and every
 * attribute value in them is a plain word. The gap was in the input domain rather than the logic,
 * so exercising the existing fixtures harder would never have reached it. These cases feed the
 * tokenizer the legal inputs no fixture used.
 *
 * The controls carry real weight. Quote-aware scanning must not break self-closing detection, which
 * is decided by a `/` immediately before the closing `>` -- and a `/` also turns up inside ordinary
 * attribute values such as a path or a URL. Widening the name class must not start matching `<!--`,
 * `<![CDATA[`, `<?xml` or `<!DOCTYPE` as elements, since those are also `<` followed by a character
 * that is not a letter.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { outlineXml, parseXml, parseXmlTree, queryXml, serializeXmlNode } from '../../src/xml_query.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, HOME: homeDir, USERPROFILE: homeDir },
  })
  return { status: res.status ?? 1, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

const GT_DOC = '<root><item title="a>b" id="1">plain</item></root>'
const UNICODE_DOC = '<datos><café precio="3">espresso</café><数据 id="7">valor</数据><plain>ok</plain></datos>'

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-xmlguard-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-xmlguard-home-'))
  writeFileSync(join(projectDir, 'gt.xml'), GT_DOC, 'utf-8')
  writeFileSync(join(projectDir, 'uni.xml'), UNICODE_DOC, 'utf-8')
})

describe('a literal > inside an attribute value', () => {
  it('does not end the start tag early', () => {
    const item = parseXml(GT_DOC).children[0]
    expect(item?.attributes.title, 'the attribute value was cut at the > inside it').toBe('a>b')
  })

  it('does not swallow the attributes that follow it', () => {
    const item = parseXml(GT_DOC).children[0]
    expect(item?.attributes.id, 'an attribute after the > was lost, and nothing said so').toBe('1')
  })

  it('leaves the element text as the text, not the remains of the start tag', () => {
    const item = parseXml(GT_DOC).children[0]
    expect(item?.text).toBe('plain')
  })

  it('handles a single-quoted value the same way', () => {
    const item = parseXml("<root><item title='a>b' id='1'>plain</item></root>").children[0]
    expect(item?.attributes).toEqual({ title: 'a>b', id: '1' })
  })

  // A `/` inside a value is common (paths, URLs), and quote-aware scanning must not let one be read
  // as the slash that makes a tag self-closing.
  it('still treats a slash inside a value as part of the value', () => {
    const item = parseXml('<root><item href="a/b">text</item></root>').children[0]
    expect(item?.attributes.href).toBe('a/b')
    expect(item?.text).toBe('text')
  })

  it('still recognises a genuinely self-closing tag', () => {
    const root = parseXml('<root><item href="a/b"/><after>x</after></root>')
    expect(root.children.map((c) => c.tag), 'a self-closing tag captured its sibling as a child').toEqual([
      'item',
      'after',
    ])
  })
})

describe('non-ASCII XML names', () => {
  it('keeps a name whose non-ASCII character is not the first', () => {
    const tags = parseXml(UNICODE_DOC).children.map((c) => c.tag)
    expect(tags, 'the tag name was truncated at its first non-ASCII character').toContain('café')
  })

  it('keeps an element whose name begins with a non-ASCII character', () => {
    const tags = parseXml(UNICODE_DOC).children.map((c) => c.tag)
    expect(tags, 'the element was dropped from the tree entirely').toContain('数据')
  })

  it('does not lose the text of a dropped element', () => {
    const node = parseXml(UNICODE_DOC).children.find((c) => c.tag === '数据')
    expect(node?.text).toBe('valor')
  })

  it('counts every element, so the outline summary is not quietly short', () => {
    expect(parseXmlTree(UNICODE_DOC).totalElements, 'the total omitted an element the document has').toBe(4)
  })

  it('parses a non-ASCII attribute name', () => {
    const node = parseXml('<r><a precio-café="3">x</a></r>').children[0]
    expect(node?.attributes['precio-café']).toBe('3')
  })

  it('can be queried by its real name', () => {
    expect(queryXml(UNICODE_DOC, 'datos/数据').items).toHaveLength(1)
  })

  it('reports the widened names in the outline', () => {
    const summary = outlineXml(UNICODE_DOC)
    expect(summary.tree?.children.map((c) => c.tag)).toEqual(['café', '数据', 'plain'])
  })

  // `<!--`, `<![CDATA[`, `<?` and `<!DOCTYPE` are all `<` followed by something that is not a
  // letter. A name class widened far enough to swallow one of them would turn a comment into an
  // element and its contents into the document.
  it('still treats comments, CDATA, instructions and the doctype as markup, not elements', () => {
    const doc = '<?xml version="1.0"?><!DOCTYPE r><r><!-- note --><![CDATA[raw > text]]><b>x</b></r>'
    const root = parseXml(doc)
    expect(root.tag).toBe('r')
    expect(root.children.map((c) => c.tag), 'markup other than an element was parsed as one').toEqual(['b'])
    expect(root.text).toContain('raw > text')
  })
})

describe('text content', () => {
  it('does not invent a space where markup merely interrupted the text', () => {
    expect(parseXml('<r>a<!--x-->b</r>').text, 'a comment added a character the document does not contain').toBe('ab')
  })

  it('keeps CDATA exactly as written, which is the whole point of CDATA', () => {
    expect(parseXml('<r><![CDATA[ a ]]></r>').text).toBe(' a ')
  })

  it('joins text either side of a CDATA section without a separator', () => {
    expect(parseXml('<r>a<![CDATA[b]]>c</r>').text).toBe('abc')
  })

  // The counterweight: a pretty-printed document is mostly newlines and indentation between tags,
  // and treating that as content would put it in every element's text and every character count.
  it('still ignores the whitespace between tags in a pretty-printed document', () => {
    expect(parseXml('<r>\n  <a>x</a>\n</r>').text, 'indentation was captured as element text').toBe('')
  })
})

describe('a doctype whose system identifier contains a >', () => {
  // A SystemLiteral is quoted and may hold any character, `>` included. Ending the doctype at the
  // first `>` let the rest of the literal be tokenized as markup, so a document could name its own
  // root: the element the tool reported was one hidden inside the doctype string.
  it('does not let an element hidden inside the literal become the root', () => {
    expect(parseXml('<!DOCTYPE r SYSTEM "x><fake/>"><r/>').tag, 'the reported root came from inside the doctype').toBe('r')
  })

  it('reports the whole doctype rather than the part before the >', () => {
    expect(parseXmlTree('<!DOCTYPE r SYSTEM "x><fake/>"><r/>').doctype).toContain('x><fake/>')
  })

  it('still reports an ordinary doctype', () => {
    expect(parseXmlTree('<!DOCTYPE note SYSTEM "note.dtd"><note/>').doctype).toContain('note')
  })
})

describe('line numbers', () => {
  it('counts from the start of the document the caller passed, not the trimmed remainder', () => {
    expect(parseXml('\n\n<r/>').line, 'leading blank lines were discarded before counting').toBe(3)
  })

  it('reports each element on its own line', () => {
    expect(parseXml('<r>\n<a/>\n<b/>\n</r>').children.map((c) => c.line)).toEqual([2, 3])
  })

  // The line number used to be recomputed by rescanning the whole preceding document for every
  // tag, which is quadratic: doubling the elements quadrupled the time, so an ordinary large
  // document was an easy way to burn CPU. Compared as a ratio rather than an absolute time, so the
  // case measures the growth rate rather than how fast the machine running it happens to be. The
  // best of three runs at each size keeps one scheduling hiccup from deciding the result.
  it('does not take quadratically longer as the document grows', () => {
    const best = (n: number): number => {
      const doc = '<r>' + '<a/>'.repeat(n) + '</r>'
      let ms = Infinity
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        parseXmlTree(doc)
        ms = Math.min(ms, performance.now() - t0)
      }
      return Math.max(ms, 1)
    }
    const small = best(30000)
    const large = best(60000)
    expect(large / small, `doubling the element count took ${(large / small).toFixed(1)}x longer`).toBeLessThan(3)
  })
})

describe('serialized attribute values', () => {
  // Whitespace in an attribute value is normalised to spaces by every conforming XML reader, so a
  // raw newline or tab in the output means something different from the document it came from.
  // token-goat's own parser round-tripped it, which is exactly why nothing noticed.
  it('escapes a newline and a tab so the value survives another reader', () => {
    const node = parseXml('<r a="x&#xA;y&#x9;z"/>')
    const out = serializeXmlNode(node)
    expect(out, 'a raw control character was emitted inside an attribute value').not.toMatch(/a="[^"]*[\n\t]/)
    expect(out).toContain('&#xA;')
    expect(out).toContain('&#x9;')
  })

  it('leaves an ordinary attribute value alone', () => {
    expect(serializeXmlNode(parseXml('<r a="plain value"/>'))).toContain('a="plain value"')
  })
})

describe('through the built binary', () => {
  it('xml-query returns the attribute that used to disappear', () => {
    const r = run(['xml-query', 'gt.xml', 'root/item/@id'])
    expect(r.status, r.out).toBe(0)
    expect(r.out.trim()).toBe('1')
  })

  it('xml-outline lists the non-ASCII elements', () => {
    const r = run(['xml-outline', 'uni.xml'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('café')
    expect(r.out, 'an element legal in XML never reached the outline').toContain('数据')
  })
})
