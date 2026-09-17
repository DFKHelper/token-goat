import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { extractEmbeddableDocumentText } from '../src/doc_embed_extract.js'
import { docxText } from '../src/docx_extract.js'
import { pptxNotesText, pptxOutline, pptxSlideText, pptxTextGrep } from '../src/pptx_extract.js'

// Provenance: CAPTURE. `INLINE_MATH_P` is the second `<w:p>` of `word/document.xml` from a .docx written by pandoc 3.6.4 (windows-x86_64 release build) from the Markdown source `Einstein wrote the mass-energy relation as $E=mc^2$ which every physics student knows.`, copied byte-for-byte including its `w:pPr`/`m:rPr` and pandoc's run splitting. Pandoc is a real shipped OMML producer, not Word: it confirms an equation really does arrive as a bare `m:oMath` sibling of the surrounding `w:r` runs, which is the fact the fix turns on. The display-equation and pptx fixtures below are not captures -- see their own provenance lines.
const INLINE_MATH_P = '<w:p><w:pPr><w:pStyle w:val="FirstParagraph" /></w:pPr><w:r><w:t xml:space="preserve">Einstein wrote the mass-energy relation as</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><m:oMath><m:r><m:t>E</m:t></m:r><m:r><m:rPr><m:sty m:val="p" /></m:rPr><m:t>=</m:t></m:r><m:r><m:t>m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t xml:space="preserve">which every physics student knows.</w:t></w:r></w:p>'

// Provenance: FORMAT-DERIVED from ECMA-376-1:2016 §22.1.2.78 (m:oMathPara), §22.1.2.77 (m:oMath), §22.1.2.87 (m:r), §22.1.2.116 (m:t); a display equation is a direct w:p child per §17.3.1.22 / EG_PContent. Not a Word capture: Word COM was unreachable from the shell on the authoring machine (no Word, no LibreOffice, no local .docx carrying m:oMath). The pandoc capture above corroborates the surrounding shape.
const DISPLAY_MATH_P = '<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="center" /></m:oMathParaPr><m:oMath><m:r><m:t>x=</m:t></m:r></m:oMath></m:oMathPara></w:p>'

const DOCX_BODY = `${INLINE_MATH_P}${DISPLAY_MATH_P}<w:p><w:r><w:t>After.</w:t></w:r></w:p>`

// Provenance: FORMAT-DERIVED from [MS-ODRAWXML] a14:m (Math) nested in mc:Choice Requires="a14", holding an m:oMathPara per ECMA-376-1 §22.1.2.78; the Fallback shape carrying one whitespace a:t is the shape a real PowerPoint deck writes, but these bytes are re-typed, not copied. The runs on BOTH sides of the a14:m wrapper are the load-bearing part: fast-xml-parser folds the two `a:r` siblings into one array keyed at the first, so a run left under the wrapper is re-read after both of them. A run on only one side does not show this -- the folded array and the wrapper still come out in document order -- and a mutation dropping the unwrap stayed green against that fixture.
function mathSlideXml(): string {
  const mathPara = '<m:oMathPara><m:oMath><m:r><m:t>E=m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara>'
  const choiceShape = `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t xml:space="preserve">where </a:t></a:r><a14:m>${mathPara}</a14:m><a:r><a:t xml:space="preserve"> exactly</a:t></a:r></a:p></p:txBody></p:sp>`
  const fallbackShape = '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr lang="en-US"/><a:t> </a:t></a:r></a:p></p:txBody></p:sp>'
  const prose = '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Mass-energy equivalence</a:t></a:r></a:p></p:txBody></p:sp>'
  return `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${prose}<mc:AlternateContent><mc:Choice Requires="a14">${choiceShape}</mc:Choice><mc:Fallback>${fallbackShape}</mc:Fallback></mc:AlternateContent></p:spTree></p:cSld></p:sld>`
}

function mathNotesXml(): string {
  return '<?xml version="1.0"?><p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t xml:space="preserve">recall </a:t></a:r><a14:m><m:oMathPara><m:oMath><m:r><m:t>E=mc2</m:t></m:r></m:oMath></m:oMathPara></a14:m></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>'
}

describe('Office Math (OMML) runs survive docx/pptx extraction', () => {
  let dir: string
  let docxFile: string
  let pptxFile: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-omml-'))
    docxFile = path.join(dir, 'equation.docx')
    fs.writeFileSync(docxFile, zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${DOCX_BODY}</w:body></w:document>`) }))
    pptxFile = path.join(dir, 'equation.pptx')
    const notesRel = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'
    fs.writeFileSync(pptxFile, zipSync({
      'ppt/slides/slide1.xml': strToU8(mathSlideXml()),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(notesRel),
      'ppt/notesSlides/notesSlide1.xml': strToU8(mathNotesXml()),
    }))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('has fixtures whose equation text exists only as m:t, never as w:t or a:t', () => {
    const slideXml = mathSlideXml()
    expect((DOCX_BODY.match(/<m:t[ >]/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((slideXml.match(/<m:t[ >]/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(/<w:t[^>]*>[^<]*(?:E=m|x=)/.test(DOCX_BODY)).toBe(false)
    expect(/<a:t[^>]*>[^<]*E=m/.test(slideXml)).toBe(false)
  })

  it('places an inline equation between the runs it sits between, not after the paragraph tail', async () => {
    const text = await docxText(docxFile)
    const lines = text.split('\n\n')
    // Exact, not toContain: a tree-level `m:t` match also makes the equation text appear somewhere, but appends it as `...knows.E=mc2` because fast-xml-parser folds the sibling `w:r` elements and loses document order.
    expect(lines[0]).toBe('Einstein wrote the mass-energy relation as E=mc2 which every physics student knows.')
    expect(lines[1]).toContain('x=')
    expect(lines[lines.length - 1]).toBe('After.')
  })

  it('keeps a PowerPoint equation shape in slide text, in order after the run beside it', async () => {
    const text = await pptxSlideText(pptxFile, 1, false)
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    expect(lines).toContain('Mass-energy equivalence')
    // `where E=mc2 exactly` and not `where exactlyE=mc2`: left under the a14:m wrapper the generated run is a grandchild of the a:p and is read after both of the folded sibling runs.
    expect(lines).toContain('where E=mc2 exactly')
    // Header plus the two real text blocks; the Fallback holds a single whitespace a:t and must not surface as a block of its own.
    expect(lines).toEqual(['# Slide 1', 'Mass-energy equivalence', 'where E=mc2 exactly'])
  })

  it('finds an equation by grep and counts it in the outline body length', async () => {
    const matches = await pptxTextGrep(pptxFile, 'E=m')
    expect(matches.map((m) => m.slide)).toEqual([1])
    const outline = await pptxOutline(pptxFile)
    expect(outline[0]?.bodyChars).toBeGreaterThan('Mass-energy equivalence'.length)
  })

  it('keeps an equation authored in the speaker notes', async () => {
    expect(await pptxNotesText(pptxFile, 1)).toContain('recall E=mc2')
  })

  it('gives the equation to the embeddings indexer, the path the worker drives unattended', async () => {
    expect(await extractEmbeddableDocumentText(docxFile)).toContain('E=mc2')
  })
})
