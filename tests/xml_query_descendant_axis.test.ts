import { describe, expect, it } from 'vitest'

import { queryXml } from '../src/xml_query.js'

// Provenance: HAND-DERIVED. The document is made up; the expected sets follow from XPath 1.0 section 2.5 (https://www.w3.org/TR/1999/REC-xpath-19991116/#path-abbrev): `a//b` is `a/descendant-or-self::node()/child::b`, i.e. the b elements that are descendants of an a (never the a itself), and a node-set holds each node once, in document order.
const NESTED = '<doc><section id="s1"><title>One</title><section id="s2"><title>Two</title><section id="s3"/></section></section><section id="s4"/></doc>'
const q = (xpath: string) => queryXml(NESTED, xpath, { xpath })
const ids = (xpath: string): string[] => q(xpath).items.map((n) => n.attributes['id'] ?? n.tag)

describe('xml-query --xpath descendant axis', () => {
  it('//section//section is the sections inside another section, each once', () => {
    expect(ids('//section//section')).toEqual(['s2', 's3'])
  })

  it('//section//title returns each title once, in document order', () => {
    expect(q('//section//title').items.map((n) => n.text)).toEqual(['One', 'Two'])
  })

  it('a leading // still includes the root and every match, in document order', () => {
    expect(ids('//section')).toEqual(['s1', 's2', 's3', 's4'])
    expect(ids('//doc')).toEqual(['doc'])
  })

  it('//a//@attr takes the attributes of descendant-or-self elements once each', () => {
    expect(q('//section//section/@id').attributeValues).toEqual(['s2', 's3'])
    expect(q('//section//@id').attributeValues).toEqual(['s1', 's2', 's3', 's4'])
    expect(q('//doc//@id').attributeValues).toEqual(['s1', 's2', 's3', 's4'])
    expect(q('//@id').attributeValues).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('/doc//section reaches sections below the root once', () => {
    expect(ids('/doc//section')).toEqual(['s1', 's2', 's3', 's4'])
  })
})
