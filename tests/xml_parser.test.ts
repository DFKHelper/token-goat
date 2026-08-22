/**
 * Holds `src/xml_parser.ts` to the exact output of the library it replaced.
 *
 * `fast-xml-parser` stays in devDependencies purely to be the oracle here. That is the same
 * arrangement `exceljs` has for the xlsx reader, and it is the opposite of the injected-seam trap
 * CLAUDE.md warns about: the thing under test is compared against a genuinely different
 * implementation, not against a mock of itself. If the two ever disagree on any shape a real
 * document can contain, one of these cases goes red and names the input.
 *
 * Three corpora, in increasing order of how much they prove:
 *
 *   1. a hand-written table of shapes, which is the only place edge cases can be stated directly;
 *   2. every XML part of a .docx and a .pptx this suite already builds;
 *   3. every XML part of a workbook written by ExcelJS, which matters because it is a third-party
 *      producer whose output nobody here designed -- it emits inline strings, shared strings,
 *      number formats and relationship parts that the hand-written table would not think to cover.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { XMLParser } from 'fast-xml-parser'

import { MAX_XML_DEPTH, decodeXmlEntities, parseXml } from '../src/xml_parser.js'
import { buildDocxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

/** The exact options ooxml_extract.ts used to pass. Changing one here invalidates the comparison. */
const oracle = new XMLParser({ ignoreAttributes: false, preserveOrder: false, trimValues: false, parseTagValue: false })

/**
 * Deep equality is not enough on its own: these trees are consumed by walking `Object.entries`, so
 * two objects with the same pairs in a different order produce collected text runs in a different
 * order. Comparing the JSON encoding compares key order as well, which is the property that
 * actually matters, and it also makes the failure message show both trees.
 */
function expectMatchesOracle(xml: string, label: string): void {
  const mine = parseXml(xml)
  const theirs = oracle.parse(xml)
  expect(JSON.stringify(mine), `parse diverged from fast-xml-parser for ${label}:\n  input: ${JSON.stringify(xml)}`).toBe(JSON.stringify(theirs))
}

const CORPUS: Record<string, string> = {
  'text-only element': '<a><b>x</b></a>',
  'repeated siblings fold to an array': '<a><b>x</b><b>y</b></a>',
  'three repeats stay in document order': '<a><b>1</b><b>2</b><b>3</b></a>',
  'interleaved repeats collapse into one array': '<a><b>1</b><c>2</c><b>3</b></a>',
  'attributes sort after #text': '<a><b id="1" w:val="hi">x</b></a>',
  'attributes with no text produce no #text key': '<a><b id="1"/></a>',
  'empty element is the empty string': '<a><b></b></a>',
  'self-closing element is the empty string': '<a><b/></a>',
  'self-closing with a space before the slash': '<a><b /></a>',
  'xml declaration becomes a ?xml key': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a><b>x</b></a>',
  'a second processing instruction gets its own key': '<?xml version="1.0"?><?mso-application progid="Word.Document"?><a>t</a>',
  'named entities decode': '<a><b>&lt;&amp;&gt;&quot;&apos;</b></a>',
  'cdata is inlined without entity decoding': '<a><b><![CDATA[<raw> & amp; &lt; stuff]]></b></a>',
  'cdata mixed with surrounding text': '<a>pre<![CDATA[<x>]]>post</a>',
  'whitespace-only text survives untrimmed': '<a><b xml:space="preserve"> </b></a>',
  'text before and after a child concatenates': '<a>text<b>x</b>tail</a>',
  'a child followed by tail text': '<a><b/>tail</a>',
  'indentation whitespace is kept': '<a>\n  <b>x</b>\n</a>',
  'numeric-looking text is never coerced': '<a><b>007</b><c>1.50</c><d>+12</d><e>1e5</e><f>0x1A</f></a>',
  'nesting': '<a><b><c>1</c></b></a>',
  'an element may nest inside one of the same name': '<a><b><b>inner</b></b></a>',
  'comments are dropped': '<a><!-- c --><b>x</b></a>',
  'namespace declarations are ordinary attributes': '<a xmlns:w="urn:x"><w:b w:val="1">t</w:b></a>',
  'an empty grandchild': '<a><b><c/></b></a>',
  'attributes on the root': '<a k="v"/>',
  'text and attributes on the root': '<a k="v">t</a>',
  'single-quoted attribute value': "<a k='v'>t</a>",
  'empty attribute value': '<a k="">t</a>',
  'whitespace around the equals sign': '<a  k = "v" >t</a>',
  'entities inside an attribute value': '<a k="&lt;&amp;&gt;">t</a>',
  'a byte-order mark before the root': '﻿<a>t</a>',
  'a doctype is skipped': '<!DOCTYPE note><a>t</a>',
  'repeated attribute-only elements': '<a><b k="1"/><b k="2"/></a>',
  'a realistic run of word paragraphs':
    '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>B</w:t></w:r></w:p>',
  // Malformed shapes. The point of these is not that the handling is elegant, it is that these
  // commands read files other software produced and a slightly broken part should still give up
  // its text. Whatever the previous library did with each, this does too.
  'unclosed inner element': '<a><b></a>',
  'unclosed root': '<a>',
  'no markup at all': 'not xml at all',
  'a closing tag matching nothing open': '<a></b></a>',
  'empty input': '',
  'text with no root element': 'bare text',
}

describe('xml_parser matches fast-xml-parser', () => {
  for (const [label, xml] of Object.entries(CORPUS)) {
    it(label, () => {
      expectMatchesOracle(xml, label)
    })
  }
})

describe('xml_parser on real OOXML parts', () => {
  /** Unzips a fixture and compares every XML part in it against the oracle, part by part. */
  function compareAllParts(zip: Uint8Array, kind: string): number {
    const entries = unzipSync(zip)
    let compared = 0
    for (const [name, bytes] of Object.entries(entries)) {
      if (!/\.(xml|rels)$/i.test(name)) continue
      const text = new TextDecoder('utf-8').decode(bytes)
      expectMatchesOracle(text, `${kind} part ${name}`)
      compared++
    }
    return compared
  }

  it('parses every part of a .docx identically', () => {
    const zip = buildDocxFixture([
      { text: 'Heading One', headingLevel: 1 },
      { text: 'Body text with a  double space, an ampersand & and a less-than <.' },
      { text: 'Trailing paragraph', headingLevel: 2 },
    ])
    // A part count is asserted so this cannot quietly pass by finding nothing to compare -- the
    // same vacuity trap the temp-leak guard had to close.
    expect(compareAllParts(zip, 'docx')).toBeGreaterThan(0)
  })

  it('parses every part of a .pptx identically', () => {
    const zip = buildPptxFixture([
      { title: 'Slide One', body: ['first bullet', 'second bullet'] },
      { title: 'Slide Two & Friends', body: ['text with <angle> brackets'] },
    ])
    expect(compareAllParts(zip, 'pptx')).toBeGreaterThan(0)
  })

  it('parses a slide with a table identically', () => {
    const slideXml =
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData>' +
      '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Header</a:t></a:r></a:p></a:txBody></a:tc>' +
      '<a:tc><a:txBody><a:p><a:r><a:t>Second</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
      '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Cell 1</a:t></a:r></a:p></a:txBody></a:tc>' +
      '<a:tc><a:txBody><a:p><a:r><a:t></a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>' +
      '</a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>'
    const zip = zipSync({ 'ppt/slides/slide1.xml': strToU8(slideXml) })
    expect(compareAllParts(zip, 'pptx table')).toBe(1)
  })
})

describe('xml_parser on a workbook written by ExcelJS', () => {
  let workbookBytes: Uint8Array
  let tempDir: string

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xmlparser-'))
    const file = path.join(tempDir, 'oracle.xlsx')
    const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet One')
    ws.addRow(['name', 'qty', 'when', 'note'])
    ws.addRow(['widget & bolt', 7, new Date(Date.UTC(2024, 0, 15)), 'has <angle> brackets'])
    ws.addRow(['zip code', '007', new Date(Date.UTC(2024, 5, 1)), 'quote " and apostrophe \''])
    ws.getCell('E2').value = { formula: 'B2*2', result: 14 }
    ws.getColumn(3).numFmt = 'yyyy-mm-dd'
    const ws2 = wb.addWorksheet('Second')
    ws2.addRow(['only', 'row'])
    await wb.xlsx.writeFile(file)
    workbookBytes = new Uint8Array(fs.readFileSync(file))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('parses every XML part of a third-party-written workbook identically', () => {
    const entries = unzipSync(workbookBytes)
    let compared = 0
    for (const [name, bytes] of Object.entries(entries)) {
      if (!/\.(xml|rels)$/i.test(name)) continue
      expectMatchesOracle(new TextDecoder('utf-8').decode(bytes), `xlsx part ${name}`)
      compared++
    }
    // A real workbook has at least workbook.xml, its rels, a styles part, a sheet and [Content_Types].
    expect(compared, 'no XML parts were compared, so this proved nothing').toBeGreaterThanOrEqual(5)
  })
})

describe('xml_parser deliberate differences from fast-xml-parser', () => {
  it('decodes numeric character references, which fast-xml-parser leaves as literal text', () => {
    const xml = '<a><b>&#65;&#x42;&#8217;</b></a>'
    // Stated as an assertion about the oracle too, not just as a comment: if a future
    // fast-xml-parser starts decoding these, this line goes red and tells us the divergence is
    // gone rather than leaving a stale claim in a docblock.
    expect((oracle.parse(xml) as { a: { b: string } }).a.b, 'fast-xml-parser now decodes numeric references; the documented divergence is stale').toBe('&#65;&#x42;&#8217;')
    expect((parseXml(xml) as { a: { b: string } }).a.b).toBe('AB’')
  })

  it('leaves an out-of-range or malformed numeric reference exactly as written', () => {
    // Inventing a replacement character here would put content in the document that the producer
    // never wrote, which is worse than showing the escape.
    expect(decodeXmlEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;')
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;')
    expect(decodeXmlEntities('&#;')).toBe('&#;')
  })

  it('refuses nesting deeper than the cap instead of overflowing a caller stack', () => {
    const deep = '<a>'.repeat(MAX_XML_DEPTH + 5) + 'x' + '</a>'.repeat(MAX_XML_DEPTH + 5)
    expect(() => parseXml(deep)).toThrow(/nesting deeper than 512/)
    // The cap must not be so tight that anything real trips it.
    expect(() => parseXml('<a>'.repeat(64) + 'x' + '</a>'.repeat(64))).not.toThrow()
  })
})

describe('xml_parser security properties', () => {
  it('does not resolve an entity declared in a DOCTYPE (XXE)', () => {
    const xml =
      '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ENTITY inline "SECRET">]>' +
      '<r><a>&xxe;</a><b>&inline;</b></r>'
    const parsed = parseXml(xml) as { r: { a: string; b: string } }
    // Both are left as literal text. There is no code path that could read the file or expand the
    // internal entity, because the declaration block is skipped without being looked at.
    expect(parsed.r.a).toBe('&xxe;')
    expect(parsed.r.b).toBe('&inline;')
  })

  it('does not expand a recursive entity definition (billion laughs)', () => {
    const xml =
      '<!DOCTYPE lolz [<!ENTITY lol "lol">' +
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
      '<lolz>&lol3;</lolz>'
    const parsed = parseXml(xml) as { lolz: string }
    expect(parsed.lolz).toBe('&lol3;')
  })

  it('does not let a > inside a quoted attribute value truncate the tag', () => {
    const parsed = parseXml('<a k="x>y" j="2">t</a>') as { a: Record<string, string> }
    expect(parsed.a['@_k']).toBe('x>y')
    expect(parsed.a['@_j']).toBe('2')
    expect(parsed.a['#text']).toBe('t')
  })

  it('skips a doctype whose internal subset contains a > character', () => {
    const parsed = parseXml('<!DOCTYPE r [<!ENTITY e "a > b">]><r>t</r>') as { r: string }
    expect(parsed.r).toBe('t')
  })
})
