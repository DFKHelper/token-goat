/**
 * Minimal in-memory .pptx/.docx fixture builder for tests, via fflate.zipSync (already a
 * project optionalDependency, so no extra test-only dep). Only includes the ZIP parts the
 * extraction code actually reads (slide/notes/document XML) -- not the full OOXML skeleton
 * (Content_Types.xml, presentation.xml, rels) real PowerPoint/Word would require to open the
 * file, since readOoxmlZip/pptx_extract/docx_extract never look at those parts.
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

export function buildPptxFixture(slides: FixtureSlide[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  slides.forEach((slide, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slideXml(slide))
    if (slide.notes !== undefined) {
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(notesXml(slide.notes))
    }
  })
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
