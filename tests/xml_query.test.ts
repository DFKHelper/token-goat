import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  parseXml,
  outlineXml,
  formatXmlOutline,
  parseXmlPath,
  queryXml,
  serializeXmlNode,
  xmlNodeToJson,
} from '../src/xml_query.js'
import { runXmlOutline, runXmlQuery } from '../src/read_commands.js'
import { captureStdout } from './helpers/capture-stdout.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function captureStderr(fn: () => void): string {
  let captured = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') captured += chunk
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = origWrite
  }
  return captured
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<catalog name="Main Catalog" version="1.0">
  <description>Sample book catalog</description>
  <book id="bk101" genre="Computer">
    <author>Gambardella, Matthew</author>
    <title>XML Developer's Guide</title>
    <price>44.95</price>
  </book>
  <book id="bk102" genre="Fantasy">
    <author>Ralls, Kim</author>
    <title>Midnight Rain</title>
    <price>5.95</price>
  </book>
  <book id="bk103" genre="Fantasy">
    <author>Corets, Eva</author>
    <title>Maeve Ascendant</title>
    <price>7.95</price>
  </book>
</catalog>`

describe('parseXml', () => {
  it('parses well-formed XML with attributes, children, and text', () => {
    const root = parseXml(SAMPLE_XML)
    expect(root.tag).toBe('catalog')
    expect(root.attributes['name']).toBe('Main Catalog')
    expect(root.attributes['version']).toBe('1.0')
    expect(root.children.length).toBe(4)
    expect(root.children[0]?.tag).toBe('description')
    expect(root.children[0]?.text).toBe('Sample book catalog')
    expect(root.children[1]?.tag).toBe('book')
    expect(root.children[1]?.attributes['id']).toBe('bk101')
  })

  it('handles self-closing tags and CDATA', () => {
    const xml = '<root><item id="1"/><data><![CDATA[Some <raw> data & stuff]]></data></root>'
    const root = parseXml(xml)
    expect(root.tag).toBe('root')
    expect(root.children[0]?.tag).toBe('item')
    expect(root.children[0]?.attributes['id']).toBe('1')
    expect(root.children[1]?.tag).toBe('data')
    expect(root.children[1]?.text).toBe('Some <raw> data & stuff')
  })

  it('handles XML entities &amp; &lt; &gt; &quot; &apos; and numeric entities', () => {
    const xml = '<msg title="Tom &amp; Jerry &quot;Show&quot;">A &lt; B &gt; C &#65; &#x42;</msg>'
    const root = parseXml(xml)
    expect(root.attributes['title']).toBe('Tom & Jerry "Show"')
    expect(root.text).toBe('A < B > C A B')
  })

  it('throws on empty or whitespace-only input', () => {
    expect(() => parseXml('')).toThrow(/No valid XML root element found/)
    expect(() => parseXml('   \n\t  ')).toThrow(/No valid XML root element found/)
  })
})

describe('outlineXml and formatXmlOutline', () => {
  it('summarizes XML structure with tag name, count, attributes, and depth', () => {
    const summary = outlineXml(SAMPLE_XML)
    expect(summary.rootTag).toBe('catalog')
    expect(summary.totalElements).toBe(14)
    expect(summary.tree.tag).toBe('catalog')
    expect(summary.tree.attributes).toEqual({ name: 'Main Catalog', version: '1.0' })
    expect(summary.tree.children.map((c) => c.tag)).toEqual([
      'description',
      'book',
      'book',
      'book',
    ])
    const bookOutline = summary.tree.children.find((c) => c.tag === 'book')
    expect(bookOutline?.attributes).toEqual({ id: 'bk101', genre: 'Computer' })
    expect(bookOutline?.children.map((c) => c.tag)).toEqual(['author', 'title', 'price'])
  })

  it('formats text outline cleanly', () => {
    const summary = outlineXml(SAMPLE_XML)
    const formatted = formatXmlOutline(summary)
    expect(formatted).toContain('<catalog> [name="Main Catalog" version="1.0"]')
    expect(formatted).toContain('  <description> (~19 chars text)')
    expect(formatted).toContain('  <book> [id="bk101" genre="Computer"]')
    expect(formatted).toContain('    <author> (~20 chars text)')
    expect(formatted).toContain('    <title> (~21 chars text)')
    expect(formatted).toContain('    <price> (~5 chars text)')
  })

  it('respects maxDepth option', () => {
    const summary = outlineXml(SAMPLE_XML, { maxDepth: 1 })
    expect(summary.tree.children.length).toBe(0)
  })
})

describe('parseXmlPath', () => {
  it('parses slash-separated and dot-separated paths', () => {
    expect(parseXmlPath('catalog/book/title')).toEqual([
      { tag: 'catalog', isRecursive: false },
      { tag: 'book', isRecursive: false },
      { tag: 'title', isRecursive: false },
    ])
    expect(parseXmlPath('catalog.book.title')).toEqual([
      { tag: 'catalog', isRecursive: false },
      { tag: 'book', isRecursive: false },
      { tag: 'title', isRecursive: false },
    ])
  })

  it('parses wildcard [*] and index [0]', () => {
    expect(parseXmlPath('catalog/book[*]/title')).toEqual([
      { tag: 'catalog', isRecursive: false },
      { tag: 'book', isRecursive: false, allIndices: true },
      { tag: 'title', isRecursive: false },
    ])
    expect(parseXmlPath('catalog/book[1]/title')).toEqual([
      { tag: 'catalog', isRecursive: false },
      { tag: 'book', isRecursive: false, index: 1 },
      { tag: 'title', isRecursive: false },
    ])
  })

  it('parses attribute selectors @attr and attribute filter [@attr=val]', () => {
    expect(parseXmlPath('catalog/book[@genre=Fantasy]/@id')).toEqual([
      { tag: 'catalog', isRecursive: false },
      { tag: 'book', isRecursive: false, attributeFilter: { name: 'genre', value: 'Fantasy' } },
      { tag: '', isRecursive: false, attributeSelect: 'id' },
    ])
  })
})

describe('queryXml', () => {
  it('extracts single element or root on non-fanned path', () => {
    const res = queryXml(SAMPLE_XML, 'catalog/book[0]/title')
    expect(res.fanned).toBe(false)
    expect(res.items.length).toBe(1)
    expect(res.items[0]?.text).toBe("XML Developer's Guide")
  })

  it('extracts multiple elements with wildcard or multi-match tags', () => {
    const res = queryXml(SAMPLE_XML, 'catalog/book[*]/title')
    expect(res.fanned).toBe(true)
    expect(res.items.length).toBe(3)
    expect(res.items.map((n) => n.text)).toEqual([
      "XML Developer's Guide",
      'Midnight Rain',
      'Maeve Ascendant',
    ])
  })

  it('filters elements by attribute [@genre=Fantasy]', () => {
    const res = queryXml(SAMPLE_XML, 'catalog/book[@genre=Fantasy]/title')
    expect(res.fanned).toBe(true)
    expect(res.items.length).toBe(2)
    expect(res.items.map((n) => n.text)).toEqual(['Midnight Rain', 'Maeve Ascendant'])
  })

  it('filters elements by child element [genre=Fantasy] or [price=3]', () => {
    const xml = `<items>
      <item><id>1</id><price>10</price></item>
      <item><id>2</id><price>3</price></item>
      <item><id>3</id><price>25</price></item>
    </items>`
    const res = queryXml(xml, 'items/item[price=3]/id')
    expect(res.fanned).toBe(true)
    expect(res.items.map((n) => n.text)).toEqual(['2'])
  })

  it('extracts attribute values with trailing @attr', () => {
    const res = queryXml(SAMPLE_XML, 'catalog/book[*]/@id')
    expect(res.fanned).toBe(true)
    expect(res.attributeValues).toEqual(['bk101', 'bk102', 'bk103'])
  })

  it('extracts single attribute value on non-fanned path', () => {
    const res = queryXml(SAMPLE_XML, 'catalog/@name')
    expect(res.fanned).toBe(false)
    expect(res.attributeValues).toEqual(['Main Catalog'])
  })

  it('converts XML node to JSON faithfully', () => {
    const root = parseXml('<user id="10"><name>Alice</name><role>Admin</role></user>')
    const json = xmlNodeToJson(root)
    expect(json).toEqual({
      '@id': '10',
      name: 'Alice',
      role: 'Admin',
    })
  })

  it('serializes XML node to clean XML string', () => {
    const root = parseXml('<book id="1"><title>Hello &amp; World</title></book>')
    const text = serializeXmlNode(root)
    expect(text).toContain('<book id="1">')
    expect(text).toContain('  <title>Hello &amp; World</title>')
    expect(text).toContain('</book>')
  })
})

describe('runXmlOutline and runXmlQuery CLI commands', () => {
  let tmpDir: string
  let xmlFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xml-test-'))
    xmlFile = path.join(tmpDir, 'test.xml')
    fs.writeFileSync(xmlFile, SAMPLE_XML, 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runXmlOutline prints outline in text mode', () => {
    const stdout = captureStdout(() => {
      const code = runXmlOutline({ file: xmlFile })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('<catalog> [name="Main Catalog" version="1.0"]')
    expect(stdout).toContain('<book> [id="bk101" genre="Computer"]')
  })

  it('runXmlOutline prints JSON when --json passed', () => {
    const stdout = captureStdout(() => {
      const code = runXmlOutline({ file: xmlFile, json: true })
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(stdout)
    expect(parsed.rootTag).toBe('catalog')
    expect(parsed.totalElements).toBe(14)
  })

  it('runXmlQuery extracts matching XML elements in text and JSON modes', () => {
    const stdoutText = captureStdout(() => {
      const code = runXmlQuery({ file: xmlFile, path: 'catalog/book[@id=bk101]' })
      expect(code).toBe(0)
    })
    expect(stdoutText).toContain('<book id="bk101" genre="Computer">')
    expect(stdoutText).toContain('<title>XML Developer\'s Guide</title>')

    const stdoutJson = captureStdout(() => {
      const code = runXmlQuery({ file: xmlFile, path: 'catalog/book[*]/@id', json: true })
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(stdoutJson)
    expect(parsed.items).toEqual(['bk101', 'bk102', 'bk103'])
  })

  it('runXmlQuery handles missing file or invalid XML gracefully', () => {
    const stderrMissing = captureStderr(() => {
      const code = runXmlQuery({ file: path.join(tmpDir, 'nonexistent.xml'), path: 'root' })
      expect(code).toBe(1)
    })
    expect(stderrMissing).toContain('Could not read')

    const badXmlFile = path.join(tmpDir, 'bad.xml')
    fs.writeFileSync(badXmlFile, '   ', 'utf8')
    const stderrBad = captureStderr(() => {
      const code = runXmlOutline({ file: badXmlFile })
      expect(code).toBe(1)
    })
    expect(stderrBad).toContain('Failed to parse XML')
  })
})

// Both the candidate list and the attribute-value list were appended with `push(...array)`, a
// call with one argument per item, which fails with "Maximum call stack size exceeded" above
// roughly 125,000 items. A 300,000-element document reached it, and `xml-query` is the command
// that exists so a document that size never has to be read whole.
describe('a document with more elements than can be spread as call arguments', () => {
  const HUGE = 200_000

  it('matches every element instead of overflowing the call stack', () => {
    const xml = `<root>${'<item id="1"/>'.repeat(HUGE)}</root>`

    expect(queryXml(xml, '/root/item').items).toHaveLength(HUGE)
  })
})
