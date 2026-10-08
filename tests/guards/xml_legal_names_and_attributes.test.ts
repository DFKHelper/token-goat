/** Guard: the XML tokenizer must parse the XML the spec calls legal, not the subset a regex is comfortable with. Two shapes of ordinary, spec-legal XML were silently mangled. A `>` inside a quoted attribute value is explicitly legal (only `<` and `&` are forbidden there), and appears in real documents any time an attribute holds a comparison, an arrow, or a fragment of markup. The tag pattern ended the element at the first `>` it saw, so `<item title="a>b" id="1">` parsed as an element whose title was `"a`, whose `id` had vanished, and the rest of whose start tag became text content. XML Names are Unicode: `<café>` and `<数据>` are as legal as `<item>`. The name class was ASCII-only, so `café` was truncated to `caf` -- the element was there under a name no query would ever ask for -- and `数据`, which begins with a non-ASCII character, was dropped from the tree entirely along with its text, while `xml-outline` still presented its summary as complete. Both failures are silent, which is what makes them worth a guard: the command exits 0 and prints a well-formed answer. A caller cannot tell a document that has no `id` attribute from one whose `id` was eaten, or a document with two children from one with three. Why didn't a test catch this: every fixture in `tests/xml_query.test.ts` is ASCII, and every attribute value in them is a plain word. The gap was in the input domain rather than the logic, so exercising the existing fixtures harder would never have reached it. These cases feed the tokenizer the legal inputs no fixture used. The controls carry real weight. Quote-aware scanning must not break self-closing detection, which is decided by a `/` immediately before the closing `>` -- and a `/` also turns up inside ordinary attribute values such as a path or a URL. Widening the name class must not start matching `<!--`, `<![CDATA[`, `<?xml` or `<!DOCTYPE` as elements, since those are also `<` followed by a character that is not a letter. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { outlineXml, parseXml, parseXmlTree, queryXml, serializeXmlNode, XML_ATTR_REGION, xmlTokenScanText } from '../../src/xml_query.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, HOME: homeDir, USERPROFILE: homeDir },
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

  // A `/` inside a value is common (paths, URLs), and quote-aware scanning must not let one be read as the slash that makes a tag self-closing.
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

  // `<!--`, `<![CDATA[`, `<?` and `<!DOCTYPE` are all `<` followed by something that is not a letter. A name class widened far enough to swallow one of them would turn a comment into an element and its contents into the document.
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

  // The counterweight: a pretty-printed document is mostly newlines and indentation between tags, and treating that as content would put it in every element's text and every character count.
  it('still ignores the whitespace between tags in a pretty-printed document', () => {
    expect(parseXml('<r>\n  <a>x</a>\n</r>').text, 'indentation was captured as element text').toBe('')
  })
})

describe('a doctype whose system identifier contains a >', () => {
  // A SystemLiteral is quoted and may hold any character, `>` included. Ending the doctype at the first `>` let the rest of the literal be tokenized as markup, so a document could name its own root: the element the tool reported was one hidden inside the doctype string.
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

  // Rescanning preceding text for every tag was quadratic. Measured by counting the string work the parser does, not by timing it: a wall-clock ratio is inflated by whatever else the machine is running (a busy host read 7.3x for a linear parser), while the count of characters touched is the same on every host. The count covers charCodeAt calls and the length of every slice, substring, split and match input, which is how a line number is derived from the text before a tag. Work done inside a single regex is not seen by the count, so the 'a tag with unpaired quotes' tests below measure growth in time for the shapes that make a pattern backtrack.
  it('does not do quadratically more string work as the document grows', () => {
    const proto = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    let touched = 0
    const originals = new Map<string, (...args: unknown[]) => unknown>()
    const wrap = (name: string, size: (self: string, result: unknown) => number): void => {
      const original = proto[name]!
      originals.set(name, original)
      proto[name] = function (this: string, ...args: unknown[]): unknown {
        const result = original.apply(this, args)
        touched += size(String(this), result)
        return result
      }
    }
    const resultLength = (_self: string, result: unknown): number => (typeof result === 'string' ? result.length : 0)
    const work = (elements: number): number => {
      const doc = '<r>' + '<a/>'.repeat(elements) + '</r>'
      touched = 0
      wrap('charCodeAt', () => 1)
      wrap('slice', resultLength)
      wrap('substring', resultLength)
      wrap('split', (self) => self.length)
      wrap('match', (self) => self.length)
      try {
        parseXmlTree(doc)
      } finally {
        for (const [name, original] of originals) proto[name] = original
        originals.clear()
      }
      return touched
    }
    const small = work(10000)
    const large = work(20000)
    expect(small, 'the counter saw no string work, so it is not measuring the parser').toBeGreaterThan(10000)
    expect(large / small, `doubling the element count did ${(large / small).toFixed(2)}x the string work`).toBeLessThan(2.5)
  })
})

describe('serialized attribute values', () => {
  // Whitespace in an attribute value is normalised to spaces by every conforming XML reader, so a raw newline or tab in the output means something different from the document it came from. token-goat's own parser round-tripped it, which is exactly why nothing noticed.
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

describe('a tag with unpaired quotes', () => {
  // The region between a tag name and its `>` used to carry a bare-quote alternative that overlapped the paired-quote ones, so a document of unclosed quotes made the engine try every way of pairing them and the time doubled with each quote. The earlier form is kept here as the reference the new one must agree with.
  const OLD_REGION = `(?:[^>"']|"[^"]*"|'[^']*'|["'])*?`
  const tagSource = (region: string): string => `<(\\/)?([A-Za-z]+)(${region})(\\/)?>`
  const tokens = (source: string, text: string): string[] => [...text.matchAll(new RegExp(source, 'g'))].map((m) => JSON.stringify([m.index, m[0], m[1], m[2], m[3], m[4]]))

  it('matches the same tokens as the overlapping form on generated inputs', () => {
    // A seeded generator over the characters that decide where a tag ends: quotes of both kinds, `>`, `/`, and the pieces of a tag. Short enough that the old form finishes on every one.
    let state = 12345
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
      return state >>> 8
    }
    const alphabet = ['<', 'a', 'b', ' ', '"', "'", '>', '/', '=', '>', '"', "'"]
    let withUnpaired = 0
    for (let i = 0; i < 20000; i++) {
      const length = 3 + (next() % 14)
      let text = ''
      for (let k = 0; k < length; k++) text += alphabet[next() % alphabet.length]
      const expected = tokens(tagSource(OLD_REGION), text)
      const actual = tokens(tagSource(XML_ATTR_REGION), xmlTokenScanText(text))
      expect(actual, `diverged on ${JSON.stringify(text)}`).toEqual(expected)
      if ((text.match(/"/g) ?? []).length % 2 === 1 || (text.match(/'/g) ?? []).length % 2 === 1) withUnpaired++
    }
    expect(withUnpaired, 'the generator produced too few inputs with an unpaired quote to mean anything').toBeGreaterThan(5000)
  })

  it('still reads a tag whose quote never closes', () => {
    expect(parseXml('<r><a b="1>text</a></r>').children[0]?.tag).toBe('a')
    expect(parseXml("<r><a b='1>text</a></r>").children[0]?.tag).toBe('a')
  })

  // The shapes that hung or doubled per quote before. Measured as growth, not duration: each size is timed five times interleaved with the other and the minimum kept, since load only ever adds time, and the later size may take at most 3.5x the earlier one for twice the input. The small pair is first because a pattern that is exponential in the number of quotes finishes there in a second and would never finish at the large one; the floor keeps a sub-millisecond baseline from turning timer noise into a ratio.
  const SHAPES: Record<string, (n: number) => string> = {
    'unclosed quotes': (n) => '<r>' + '<a b="'.repeat(n),
    'paired quotes, no >': (n) => '<r><a ' + '"x"'.repeat(n),
    'lone double quotes': (n) => '<r><a ' + '"'.repeat(n),
    'attributes, no >': (n) => '<r><a ' + 'b="1" '.repeat(n),
    'tag starts, no >': (n) => '<r>' + '<a b '.repeat(n),
    'unterminated comment': (n) => '<r>' + '<!--'.repeat(n),
    'unterminated CDATA': (n) => '<r>' + '<![CDATA['.repeat(n),
    'unterminated instruction': (n) => '<r>' + '<?x '.repeat(n),
    'unterminated doctype': (n) => '<r>' + '<!DOCTYPE a '.repeat(n),
  }
  const minOfFive = (small: string, large: string): { a: number; b: number } => {
    let a = Infinity
    let b = Infinity
    for (let rep = 0; rep < 5; rep++) {
      let t = performance.now()
      parseXmlTree(small)
      a = Math.min(a, performance.now() - t)
      t = performance.now()
      parseXmlTree(large)
      b = Math.min(b, performance.now() - t)
    }
    return { a, b }
  }

  // The region on its own, without the cut-off parseXmlTree applies first: that cut-off already keeps these documents away from the pattern, so a parser-level test cannot tell an ambiguous region from an unambiguous one. Exponential in the number of quotes is what is being ruled out, so the pair is small and the bound is the same 3.5.
  it('has a region that does not slow down exponentially with the number of quotes', () => {
    const source = tagSource(XML_ATTR_REGION)
    const time = (n: number): number => {
      const text = '<a b="'.repeat(n)
      let best = Infinity
      for (let rep = 0; rep < 5; rep++) {
        const t = performance.now()
        new RegExp(source).exec(text)
        best = Math.min(best, performance.now() - t)
      }
      return best
    }
    const small = time(14)
    const large = time(28)
    expect(large / Math.max(small, 0.25), `14 quotes took ${small.toFixed(2)} ms, 28 took ${large.toFixed(2)} ms`).toBeLessThan(3.5)
  })

  for (const [name, build] of Object.entries(SHAPES)) {
    it(`does not slow down faster than its input grows: ${name}`, () => {
      for (const [n, label] of [[16, 'small'], [1500, 'large']] as const) {
        const { a, b } = minOfFive(build(n), build(2 * n))
        expect(b / Math.max(a, 0.25), `${name}, ${label} pair (${n} then ${2 * n}): ${a.toFixed(2)} ms then ${b.toFixed(2)} ms`).toBeLessThan(3.5)
      }
    })
  }
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
