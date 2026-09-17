import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { docxOutline, docxTables, docxText, formatDocxTables } from '../src/docx_extract.js'
import { strToU8, zipSync } from 'fflate'
import { buildDocxFixture, buildDocxWithTableFixture } from './helpers/ooxml_fixtures.js'

let dir: string
let file: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx-'))
  file = path.join(dir, 'sample.docx')
  const bytes = buildDocxFixture([
    { text: 'Project Plan', headingLevel: 1 },
    { text: 'This document outlines the plan for the widget launch.' },
    { text: 'Timeline', headingLevel: 2 },
    { text: 'Phase 1 starts in Q1.' },
    { text: 'Budget', headingLevel: 2 },
    { text: 'The budget is $50,000.' },
  ])
  fs.writeFileSync(file, bytes)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('docxOutline', () => {
  it('returns only heading paragraphs with their level', async () => {
    const headings = await docxOutline(file)
    expect(headings).toEqual([
      { level: 1, text: 'Project Plan' },
      { level: 2, text: 'Timeline' },
      { level: 2, text: 'Budget' },
    ])
  })

  it('returns an empty array for a document with no headings', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx-noh-'))
    const file2 = path.join(dir2, 'plain.docx')
    fs.writeFileSync(file2, buildDocxFixture([{ text: 'Just a plain paragraph.' }]))
    expect(await docxOutline(file2)).toEqual([])
    fs.rmSync(dir2, { recursive: true, force: true })
  })
})

describe('docxText', () => {
  it('returns all paragraph text, including headings, joined by blank lines', async () => {
    const text = await docxText(file)
    expect(text).toContain('Project Plan')
    expect(text).toContain('This document outlines the plan for the widget launch.')
    expect(text).toContain('The budget is $50,000.')
    expect(text.split('\n\n')).toHaveLength(6)
  })

  // A paragraph whose whole text is digits was being handed back as a number: an order number
  // reading `007` printed as `7`, a version reading `1.50` as `1.5`. Mixed text was untouched,
  // so the corruption only hit the short standalone values most likely to be an identifier.
  it('returns a numeric-looking paragraph as the text it was written as', async () => {
    const f = path.join(dir, 'numeric.docx')
    fs.writeFileSync(
      f,
      buildDocxFixture([{ text: 'Order 007' }, { text: '007' }, { text: '1.50' }, { text: '0x1A' }, { text: '1e5' }]),
    )
    expect(await docxText(f)).toBe('Order 007\n\n007\n\n1.50\n\n0x1A\n\n1e5')
  })
})

describe('docxTables and formatDocxTables', () => {
  it('extracts table rows and formats as markdown table', async () => {
    const tableFile = path.join(dir, 'table.docx')
    const tableData = [
      ['NvdManufacturer', 'OEMOptionCode', 'Description'],
      ['FORD', 'MO44', 'Winter pack'],
      ['FIAT', 'COLINT#205', 'Eco-Leather'],
    ]
    fs.writeFileSync(tableFile, buildDocxWithTableFixture([tableData]))

    const tables = await docxTables(tableFile)
    expect(tables).toHaveLength(1)
    expect(tables[0]).toEqual({
      tableIndex: 1,
      rowCount: 3,
      colCount: 3,
      rows: tableData,
    })

    const formatted = formatDocxTables(tables)
    expect(formatted).toContain('Table 1 (3 rows x 3 cols):')
    expect(formatted).toContain('| NvdManufacturer | OEMOptionCode | Description |')
    expect(formatted).toContain('| --- | --- | --- |')
    expect(formatted).toContain('| FORD | MO44 | Winter pack |')
  })

  it('filters table by index when requested', async () => {
    const multiFile = path.join(dir, 'multi-table.docx')
    const t1 = [['A', 'B'], ['1', '2']]
    const t2 = [['C', 'D'], ['3', '4']]
    fs.writeFileSync(multiFile, buildDocxWithTableFixture([t1, t2]))

    const tables = await docxTables(multiFile)
    expect(tables).toHaveLength(2)

    const formattedT2 = formatDocxTables(tables, { tableIndex: 2 })
    expect(formattedT2).toContain('Table 2')
    expect(formattedT2).toContain('| C | D |')
    expect(formattedT2).not.toContain('Table 1')
  })

  // Provenance: CAPTURE. `word/document.xml` of a .docx written by python-docx 1.2.0: a 2x2 table whose bottom-left cell holds two paragraphs and whose bottom-right cell holds an empty paragraph followed by a nested 2x2 table. Trimmed to the `w:tbl` subtree and to the attributes the extractor reads; the element nesting, the two sibling `w:p` in one `w:tc`, and the `w:tbl` inside a `w:tc` are verbatim. The generic fixture builder cannot express either shape: every cell it writes is exactly one paragraph of exactly one run, which is why neither defect below had a failing test.
  const NESTED_TABLE_DOCX =
    '<?xml version="1.0"?><w:document><w:body><w:tbl>' +
    '<w:tr><w:tc><w:p><w:r><w:t>O00</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>O01</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>Line one</w:t></w:r></w:p><w:p><w:r><w:t>Line two</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p/><w:tbl>' +
    '<w:tr><w:tc><w:p><w:r><w:t>N00</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>N01</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>N10</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>N11</w:t></w:r></w:p></w:tc></w:tr>' +
    '</w:tbl></w:tc></w:tr></w:tbl></w:body></w:document>'

  function writeNestedTableDocx(): string {
    const p = path.join(dir, 'nested-table.docx')
    fs.writeFileSync(p, zipSync({ 'word/document.xml': strToU8(NESTED_TABLE_DOCX) }))
    return p
  }

  it('separates the paragraphs of a multi-paragraph cell instead of gluing them into one word', async () => {
    const tables = await docxTables(writeNestedTableDocx())
    expect(tables[0]?.rows[1]?.[0]).toBe('Line one Line two')
  })

  it('reports a nested table as its own table and keeps its cells out of the parent cell', async () => {
    const tables = await docxTables(writeNestedTableDocx())
    expect(tables).toHaveLength(2)
    expect(tables[1]).toEqual({ tableIndex: 2, rowCount: 2, colCount: 2, rows: [['N00', 'N01'], ['N10', 'N11']] })
    // The parent cell holds the nested table and nothing else, so its own text is empty. The defect flattened all four nested cells into it as the single run `N00N01N10N11`.
    expect(tables[0]?.rows[1]?.[1]).toBe('')
  })

  it('returns friendly notice when no tables found', async () => {
    const tables = await docxTables(file)
    expect(tables).toEqual([])
    expect(formatDocxTables(tables)).toBe('no tables found in document')
  })
})

describe('cell text the folded parse tree cannot position exactly', () => {
  let dir2: string
  beforeAll(() => {
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx2-'))
  })
  afterAll(() => {
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  function writeDocx(name: string, bodyXml: string): string {
    const p = path.join(dir2, name)
    fs.writeFileSync(p, zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>`) }))
    return p
  }

  // Provenance: HAND-DERIVED from ECMA-376 part 1 section 17.3.3.1 (`w:br`, an explicit break inside a paragraph's run content, so it sits inside a `w:r` like every other run element). The point is the shape, not a byte capture: two text runs with a break between them are two lines, so concatenating them makes one word out of two, and a markdown cell cannot hold the newline.
  it('puts a space where a line break separates two runs, rather than gluing them', async () => {
    const file2 = writeDocx('line-break.docx', '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Beta</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
    const tables = await docxTables(file2)
    expect(tables[0]?.rows[0]?.[0]).toBe('Alpha Beta')
  })

  // A cell whose only child is a nested table has no paragraph of its own, which is the one input that reaches collectParagraphTexts's no-paragraph fallback. A fallback blind to the nested-table skip scans the whole cell subtree and reports INNER twice: once as this cell's text and once as the nested table.
  it('does not let the no-paragraph fallback pull a nested table back into the parent cell', async () => {
    const file2 = writeDocx('bare-nested.docx', '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>INNER</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>')
    const tables = await docxTables(file2)
    expect(tables[0]?.rows[0]?.[0]).toBe('')
    expect(tables[1]?.rows).toEqual([['INNER']])
  })
})

describe('tabs and breaks between runs', () => {
  let dir3: string
  beforeAll(() => {
    dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx3-'))
  })
  afterAll(() => {
    fs.rmSync(dir3, { recursive: true, force: true })
  })

  function writeDocx(name: string, bodyXml: string): string {
    const p = path.join(dir3, name)
    fs.writeFileSync(p, zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>`) }))
    return p
  }

  // Provenance: CAPTURE. The two run shapes are copied byte-for-byte (rsid and rPr included) from `word/document.xml` of an NDA saved by Microsoft Office Word (docProps/app.xml `<Application>Microsoft Office Word`): a run holding only `<w:tab/>` between the section number and its heading, and a run whose `<w:tab/>` precedes its own `<w:t>`. That file holds 16 such tabs and docx-text printed every one of them as nothing, `Section 1.Definitions.`.
  it('keeps a Word tab as a tab character between the runs it separates', async () => {
    const rPr = '<w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
    const bold = '<w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
    const f = writeDocx('tabs.docx',
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r w:rsidRPr="001144AA">${bold}<w:t>Section 1</w:t></w:r><w:r w:rsidRPr="001144AA">${rPr}<w:t>.</w:t></w:r><w:r w:rsidRPr="001144AA">${rPr}<w:tab/></w:r><w:r w:rsidRPr="001144AA">${bold}<w:t>Definitions.</w:t></w:r></w:p>` +
      `<w:p><w:r w:rsidRPr="001144AA">${bold}<w:t>Section 3.</w:t></w:r><w:r w:rsidRPr="001144AA">${bold}<w:tab/><w:t>Confidentiality Obligation</w:t></w:r></w:p>`)
    const text = await docxText(f)
    expect(text).toBe('Section 1.\tDefinitions.\n\nSection 3.\tConfidentiality Obligation')
    expect(text).not.toContain('Section 1.Definitions')
    expect(await docxOutline(f)).toEqual([{ level: 1, text: 'Section 1.\tDefinitions.' }])
  })

  // Provenance: HAND-DERIVED from ECMA-376 part 1 section 17.3.3.30 (`w:tab`, tab character): one run may hold text on both sides of the tab. A per-paragraph "join with a space" cannot place it, and neither can the folded tree; only the XML text knows where it sat.
  it('places a tab that sits between two text elements of the same run', async () => {
    const f = writeDocx('tab-in-run.docx', '<w:p><w:r><w:t>Name:</w:t><w:tab/><w:t>Value</w:t></w:r></w:p>')
    expect(await docxText(f)).toBe('Name:\tValue')
  })

  // Provenance: CAPTURE. `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` is how Microsoft Macintosh Word writes a manual page break (three of them in a license draft on this machine); a tab-stop definition `<w:tab w:val="left" w:pos="720"/>` is what `w:tabs` holds in the same file's paragraph properties. Neither is a character: the page break must not become a paragraph of its own and the tab stop must not become a tab.
  it('does not turn a page break or a tab-stop definition into text', async () => {
    const f = writeDocx('page-break.docx',
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Before</w:t></w:r></w:p>' +
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
      '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>')
    expect(await docxText(f)).toBe('Before\n\nLine one\nLine two')
  })
})

describe('a text box written as markup-compatibility alternate content', () => {
  let dir4: string
  beforeAll(() => {
    dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx4-'))
  })
  afterAll(() => {
    fs.rmSync(dir4, { recursive: true, force: true })
  })

  function writeDocx(name: string, bodyXml: string): string {
    const p = path.join(dir4, name)
    fs.writeFileSync(p, zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>`) }))
    return p
  }

  // Provenance: CAPTURE. The paragraph is `word/document.xml` of `tests/test-data/text-box.docx` in the python-mammoth repository (docProps/app.xml `<Application>Microsoft Office Word`, AppVersion 14), with the anchor geometry, shape properties and `v:shapetype` between the two `w:txbxContent` elements left out; element names, nesting, rsids and the `_GoBack` bookmarks are byte-for-byte. Word puts the box's paragraph under `mc:Choice > w:drawing > wps:txbx` and again under `mc:Fallback > w:pict > v:shape > v:textbox`, and docx-text printed `Datum planeDatum plane` for it.
  it('emits the text of a Word text box once, not once per markup-compatibility branch', async () => {
    const box = '<w:txbxContent><w:p w:rsidR="00487BF9" w:rsidRDefault="00487BF9"><w:r><w:t>Datum plane</w:t></w:r><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/></w:p></w:txbxContent>'
    const f = writeDocx('text-box.docx',
      '<w:p w:rsidR="003872F6" w:rsidRDefault="00487BF9"><w:r><w:rPr><w:noProof/><w:lang w:eastAsia="en-GB"/></w:rPr><mc:AlternateContent>' +
      `<mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="307" name="Text Box 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx>${box}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape id="Text Box 2" o:spid="_x0000_s1026" type="#_x0000_t202"><v:textbox style="mso-fit-shape-to-text:t">${box.replace(/w:id="0"/g, 'w:id="1"')}</v:textbox></v:shape></w:pict></mc:Fallback>` +
      '</mc:AlternateContent></w:r></w:p>')
    expect(await docxText(f)).toBe('Datum plane')
  })
})
