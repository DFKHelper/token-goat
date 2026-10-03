import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runXmlQuery } from '../src/read_structured_data.js'
import { parseXml, queryXml, serializeXmlNode } from '../src/xml_query.js'
import { captureStdout } from './helpers/capture-stdout.js'

// Provenance: HAND-DERIVED. The documents are made up; the expected positions follow from XPath 1.0 section 2.4 (https://www.w3.org/TR/1999/REC-xpath-19991116/#predicates), where a numeric predicate [n] selects the n-th node, counting from 1, among the siblings the step selected under each parent.
const ITEMS = '<root><item id="1"/><item id="2"/><item id="3"/></root>'
const GROUPS = '<root><g><b id="a1"/><b id="a2"/></g><g><b id="b1"/><b id="b2"/></g></root>'

const ids = (xml: string, xpath: string): string[] => queryXml(xml, xpath, { xpath }).items.map((n) => n.attributes['id'] ?? '')

describe('xml-query --xpath positions are 1-based and apply per parent', () => {
  it('[1] is the first item, [3] the last, [4] nothing', () => {
    expect(ids(ITEMS, '/root/item[1]')).toEqual(['1'])
    expect(ids(ITEMS, '/root/item[2]')).toEqual(['2'])
    expect(ids(ITEMS, '/root/item[3]')).toEqual(['3'])
    expect(ids(ITEMS, '/root/item[4]')).toEqual([])
  })

  it('[0] selects nothing, since XPath positions start at 1', () => {
    expect(ids(ITEMS, '/root/item[0]')).toEqual([])
  })

  it('last() still selects the final sibling', () => {
    expect(ids(ITEMS, '/root/item[last()]')).toEqual(['3'])
  })

  it('//g/b[1] is the first b of each g, not the first b overall', () => {
    expect(ids(GROUPS, '//g/b[1]')).toEqual(['a1', 'b1'])
    expect(ids(GROUPS, '//g/b[2]')).toEqual(['a2', 'b2'])
  })

  it('//b[1] counts within each parent for a recursive step', () => {
    expect(ids(GROUPS, '//b[1]')).toEqual(['a1', 'b1'])
    expect(ids(GROUPS, '//b[last()]')).toEqual(['a2', 'b2'])
  })

  it('the dotted path syntax keeps its 0-based index', () => {
    expect(queryXml(ITEMS, 'root/item[0]').items.map((n) => n.attributes['id'])).toEqual(['1'])
    expect(queryXml(ITEMS, 'root/item[2]').items.map((n) => n.attributes['id'])).toEqual(['3'])
  })
})

describe('xml-query keeps mixed content in document order', () => {
  it('serializes text between and after child elements where it was written', () => {
    const root = parseXml('<p>One<b>bold</b>Two</p>')
    expect(serializeXmlNode(root)).toBe('<p>\n  One\n  <b>bold</b>\n  Two\n</p>')
  })

  it('keeps text after the last child and CDATA in order', () => {
    const root = parseXml('<p><i>x</i>tail<![CDATA[<raw>]]></p>')
    expect(serializeXmlNode(root)).toBe('<p>\n  <i>x</i>\n  tail&lt;raw&gt;\n</p>')
  })

  it('leaves text-only and element-only nodes as before', () => {
    expect(serializeXmlNode(parseXml('<a>hi</a>'))).toBe('<a>hi</a>')
    expect(serializeXmlNode(parseXml('<a><b/></a>'))).toBe('<a>\n  <b/>\n</a>')
  })

  it('still exposes all text on node.text for the filters', () => {
    expect(parseXml('<p>One<b>bold</b>Two</p>').text).toBe('OneTwo')
  })
})

describe('xml-query exit status on a miss', () => {
  let tmpDir: string
  let file: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xml-miss-'))
    file = path.join(tmpDir, 'items.xml')
    fs.writeFileSync(file, ITEMS, 'utf8')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exits 1 for a dotted path that matches nothing, and 0 for one that matches', () => {
    let code = -1
    captureStdout(() => {
      code = runXmlQuery({ file, path: 'root.nope' })
    })
    expect(code).toBe(1)
    captureStdout(() => {
      code = runXmlQuery({ file, path: 'root.item[0]' })
    })
    expect(code).toBe(0)
  })

  it('exits 1 for an --xpath that matches nothing', () => {
    let code = -1
    captureStdout(() => {
      code = runXmlQuery({ file, xpath: '/root/item[4]' })
    })
    expect(code).toBe(1)
  })

  it('exits 1 for a missing attribute selection', () => {
    let code = -1
    captureStdout(() => {
      code = runXmlQuery({ file, path: 'root.item[0].@nope' })
    })
    expect(code).toBe(1)
  })
})
