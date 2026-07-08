/**
 * Minimal in-memory .pptx/.docx fixture builder for tests, via fflate.zipSync (already a
 * project optionalDependency, so no extra test-only dep). Includes only the ZIP parts the
 * extraction code actually reads: slide/notes/document XML always, plus presentation.xml
 * and its rels when `buildPptxFixture`'s optional `order` param is used (to exercise
 * presentation-display-order resolution) -- not the full OOXML skeleton (Content_Types.xml
 * etc.) real PowerPoint/Word would require to open the file.
 */

import { strToU8, zipSync } from 'fflate'

export interface FixtureSlide {
  title?: string
  body?: string[]
  notes?: string
}

function runXml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<a:p><a:r><a:t>${escaped}</a:t></a:r></a:p>`
}

function slideXml(slide: FixtureSlide): string {
  const titleShape = slide.title !== undefined
    ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${runXml(slide.title)}</p:txBody></p:sp>`
    : ''
  const bodyShape =
    slide.body && slide.body.length > 0
      ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${slide.body.map(runXml).join('')}</p:txBody></p:sp>`
      : ''
  return `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${titleShape}${bodyShape}</p:spTree></p:cSld></p:sld>`
}

function notesXml(notes: string): string {
  return `<?xml version="1.0"?><p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${runXml(notes)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
}

/**
 * `order`: 1-based physical `slideN.xml` indices in display order, e.g. `[3, 1, 2]` means
 * physical slide 3 displays first. When provided, emits `ppt/presentation.xml` +
 * `ppt/_rels/presentation.xml.rels` so tests can exercise presentation-order resolution
 * (`slidePathsInPresentationOrder` in src/pptx_extract.ts) instead of the filename-order
 * fallback -- a reordered/duplicated/deleted-slide deck is exactly the case filename order
 * gets wrong, since PowerPoint never renames `slideN.xml` parts to match display order.
 */
/**
 * `notesTargets`: maps a 1-based physical slide index to the physical `notesSlideN.xml`
 * index its relationship should point at (defaults to the same index). Lets tests simulate
 * PowerPoint's independent notesSlide numbering counter, e.g. a duplicated slide whose notes
 * part lands at a non-matching number.
 */
export function buildPptxFixture(slides: FixtureSlide[], order?: number[], notesTargets?: Record<number, number>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  slides.forEach((slide, i) => {
    const slideNum = i + 1
    files[`ppt/slides/slide${slideNum}.xml`] = strToU8(slideXml(slide))
    if (slide.notes !== undefined) {
      const notesNum = notesTargets?.[slideNum] ?? slideNum
      files[`ppt/notesSlides/notesSlide${notesNum}.xml`] = strToU8(notesXml(slide.notes))
      files[`ppt/slides/_rels/slide${slideNum}.xml.rels`] =
        strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesNum}.xml"/></Relationships>`)
    }
  })
  if (order !== undefined) {
    const sldIds = order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')
    files['ppt/presentation.xml'] =
      strToU8(`<?xml version="1.0"?><p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`)
    const rels = order.map((n, i) => `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${n}.xml"/>`).join('')
    files['ppt/_rels/presentation.xml.rels'] =
      strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`)
  }
  return zipSync(files)
}

export interface FixtureParagraph {
  text: string
  headingLevel?: number
}

function paragraphXml(p: FixtureParagraph): string {
  const escaped = p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const pPr = p.headingLevel !== undefined ? `<w:pPr><w:pStyle w:val="Heading${p.headingLevel}"/></w:pPr>` : ''
  return `<w:p>${pPr}<w:r><w:t>${escaped}</w:t></w:r></w:p>`
}

export function buildDocxFixture(paragraphs: FixtureParagraph[]): Uint8Array {
  const body = paragraphs.map(paragraphXml).join('')
  const xml = `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`
  return zipSync({ 'word/document.xml': strToU8(xml) })
}
