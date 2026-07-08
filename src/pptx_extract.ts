/**
 * PowerPoint (.pptx) narrow-slice reader. Slide XML lives at `ppt/slides/slideN.xml`, one file
 * per slide, each a `p:sld > p:cSld > p:spTree` tree of shapes (`p:sp`); each shape has an
 * optional `p:txBody` of paragraphs (`a:p`) of runs (`a:r`) of text (`a:t`). A slide's title
 * placeholder is the shape whose `p:nvSpPr.p:nvPr.p:ph.@_type` is `title`/`ctrTitle`. Speaker
 * notes live in a sibling `ppt/notesSlides/notesSlideN.xml` part, in the shape whose
 * `p:ph.@_type` is `body` (the other notes-slide shape is a non-text slide-image placeholder).
 */

import { collectElements, collectTextRuns, decodeZipEntry, parseOoxmlPart, readOoxmlZip, sortNumberedParts } from './ooxml_extract.js'

export interface SlideOutlineEntry {
  slide: number
  title: string
  bodyChars: number
  hasNotes: boolean
}

interface ShapeLike {
  'p:nvSpPr'?: { 'p:nvPr'?: { 'p:ph'?: { '@_type'?: string } } }
}

function shapePlaceholderType(shape: unknown): string | undefined {
  const sp = shape as ShapeLike
  return sp['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type']
}

function slideShapes(parsedSlide: unknown): unknown[] {
  return collectElements(parsedSlide, 'p:sp')
}

function shapeText(shape: unknown): string {
  return collectTextRuns(shape, 'a:t').join(' ').trim()
}

interface RelationshipLike {
  '@_Id'?: string
  '@_Target'?: string
}

interface SldIdLike {
  '@_r:id'?: string
}

/**
 * Resolves the deck's actual display order (`ppt/presentation.xml`'s `<p:sldIdLst>`,
 * a list of `r:id` references, resolved to file paths via `ppt/_rels/presentation.xml.rels`)
 * rather than trusting `slideN.xml` filenames, which reflect insertion order and go stale
 * the moment a slide is reordered, duplicated, or deleted -- both very common PowerPoint
 * operations. Returns null when either part is missing/unparseable so the caller can fall
 * back to filename order (e.g. a hand-built or non-standard .pptx).
 */
async function slidePathsInPresentationOrder(entries: Record<string, Uint8Array>): Promise<string[] | null> {
  const presXml = decodeZipEntry(entries, 'ppt/presentation.xml')
  const relsXml = decodeZipEntry(entries, 'ppt/_rels/presentation.xml.rels')
  if (presXml === null || relsXml === null) return null

  const presParsed = await parseOoxmlPart(presXml)
  const relsParsed = await parseOoxmlPart(relsXml)

  const ridToTarget = new Map<string, string>()
  for (const rel of collectElements(relsParsed, 'Relationship') as RelationshipLike[]) {
    if (rel['@_Id'] !== undefined && rel['@_Target'] !== undefined) {
      ridToTarget.set(rel['@_Id'], rel['@_Target'])
    }
  }

  const ordered: string[] = []
  for (const sldId of collectElements(presParsed, 'p:sldId') as SldIdLike[]) {
    const rid = sldId['@_r:id']
    if (rid === undefined) continue
    const target = ridToTarget.get(rid)
    if (target === undefined) continue
    const normalized = target.startsWith('slides/') ? `ppt/${target}` : `ppt/slides/${target}`
    if (entries[normalized] !== undefined) ordered.push(normalized)
  }

  return ordered.length > 0 ? ordered : null
}

async function listSlideParts(filePath: string): Promise<{ entries: Record<string, Uint8Array>; slidePaths: string[] }> {
  const entries = await readOoxmlZip(filePath)
  const slidePaths =
    (await slidePathsInPresentationOrder(entries)) ??
    sortNumberedParts(
      Object.keys(entries).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)),
      /slide(\d+)\.xml$/,
    )
  if (slidePaths.length === 0) throw new Error(`no slides found in ${filePath} (not a valid .pptx?)`)
  return { entries, slidePaths }
}

function notesPathFor(slidePath: string): string {
  const m = /slide(\d+)\.xml$/.exec(slidePath)
  const n = m?.[1] ?? '1'
  return `ppt/notesSlides/notesSlide${n}.xml`
}

async function parseSlide(entries: Record<string, Uint8Array>, path: string): Promise<unknown> {
  const xml = decodeZipEntry(entries, path)
  if (xml === null) throw new Error(`missing part: ${path}`)
  return parseOoxmlPart(xml)
}

/**
 * PowerPoint auto-creates a notesSlideN.xml part for essentially every slide as soon as a
 * deck is saved, whether or not the user ever typed anything into the notes pane -- so mere
 * presence of the ZIP part is not a reliable "this slide has notes" signal. Returns the
 * actual extracted notes body text (empty string if the part is absent or its body
 * placeholder has no text), so callers can check length instead of presence.
 */
async function notesTextFor(entries: Record<string, Uint8Array>, notesPath: string): Promise<string> {
  const xml = decodeZipEntry(entries, notesPath)
  if (xml === null) return ''
  const parsed = await parseOoxmlPart(xml)
  const shapes = collectElements(parsed, 'p:sp')
  const bodyShape = shapes.find((s) => shapePlaceholderType(s) === 'body')
  return bodyShape !== undefined ? shapeText(bodyShape) : collectTextRuns(parsed, 'a:t').join(' ').trim()
}

export async function pptxOutline(filePath: string): Promise<SlideOutlineEntry[]> {
  const { entries, slidePaths } = await listSlideParts(filePath)
  const out: SlideOutlineEntry[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    const path = slidePaths[i] as string
    const parsed = await parseSlide(entries, path)
    const shapes = slideShapes(parsed)
    const titleShape = shapes.find((s) => {
      const t = shapePlaceholderType(s)
      return t === 'title' || t === 'ctrTitle'
    })
    const title = titleShape !== undefined ? shapeText(titleShape) : ''
    const allText = collectTextRuns(parsed, 'a:t').join(' ')
    const bodyChars = Math.max(0, allText.length - title.length)
    const hasNotes = (await notesTextFor(entries, notesPathFor(path))).length > 0
    out.push({ slide: i + 1, title, bodyChars, hasNotes })
  }
  return out
}

export async function pptxSlideText(filePath: string, slideNumber: number, includeNotes: boolean): Promise<string> {
  const { entries, slidePaths } = await listSlideParts(filePath)
  if (slideNumber < 1 || slideNumber > slidePaths.length) {
    throw new Error(`slide ${slideNumber} out of range (this deck has ${slidePaths.length} slides)`)
  }
  const path = slidePaths[slideNumber - 1] as string
  const parsed = await parseSlide(entries, path)
  const shapes = slideShapes(parsed)
  const blocks = shapes.map(shapeText).filter((t) => t.length > 0)
  const lines = [`# Slide ${slideNumber}`, ...blocks]
  if (includeNotes) {
    const notes = (await pptxNotesText(filePath, slideNumber)).replace(/^# Slide \d+ notes\n\n/, '')
    if (notes.length > 0) lines.push('', '## Speaker notes', notes)
  }
  return lines.join('\n\n')
}

export async function pptxNotesText(filePath: string, slideNumber?: number): Promise<string> {
  const { entries, slidePaths } = await listSlideParts(filePath)
  const targets = slideNumber !== undefined ? [slideNumber] : slidePaths.map((_, i) => i + 1)
  const sections: string[] = []
  for (const n of targets) {
    if (n < 1 || n > slidePaths.length) throw new Error(`slide ${n} out of range (this deck has ${slidePaths.length} slides)`)
    const notesPath = notesPathFor(slidePaths[n - 1] as string)
    const text = await notesTextFor(entries, notesPath)
    if (text.length > 0) sections.push(`# Slide ${n} notes\n\n${text}`)
  }
  return sections.join('\n\n')
}

export interface PptxTextMatch {
  slide: number
  snippet: string
}

export async function pptxTextGrep(filePath: string, pattern: string): Promise<PptxTextMatch[]> {
  const { entries, slidePaths } = await listSlideParts(filePath)
  const re = new RegExp(pattern, 'i')
  const out: PptxTextMatch[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    const parsed = await parseSlide(entries, slidePaths[i] as string)
    const text = collectTextRuns(parsed, 'a:t').join(' ')
    if (re.test(text)) {
      const idx = text.search(re)
      const snippet = text.slice(Math.max(0, idx - 40), idx + 80).trim()
      out.push({ slide: i + 1, snippet })
    }
  }
  return out
}
