/** PowerPoint (.pptx) narrow-slice reader. Slide XML lives at `ppt/slides/slideN.xml`, one file per slide, each a `p:sld > p:cSld > p:spTree` tree of shapes (`p:sp`); each shape has an optional `p:txBody` of paragraphs (`a:p`) of runs (`a:r`) of text (`a:t`). A slide's title placeholder is the shape whose `p:nvSpPr.p:nvPr.p:ph.@_type` is `title`/`ctrTitle`. Speaker notes live in a sibling `ppt/notesSlides/notesSlideN.xml` part, in the shape whose `p:ph.@_type` is `body` (the other notes-slide shape is a non-text slide-image placeholder). */

import { assertOoxmlWithinDeadline, collectElements, collectParagraphTexts, decodeZipEntry, inlineMathRuns, NotAnOfficeDocumentError, ooxmlPartBudget, ooxmlWorkDeadline, parseOoxmlPart, readOoxmlZip, sortNumberedParts, type OoxmlPartBudget } from './ooxml_extract.js'
import { compileGuardedRegex } from './regex_guard.js'

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

/** Every paragraph under `node`, joined with a single space. Joining the raw `a:t` runs instead fabricates a space at every formatting boundary, so a title whose second half is bold reads as two words and no longer matches a search for the word it actually is. */
function flatSlideText(node: unknown): string {
  return collectParagraphTexts(node, 'a:p', 'a:t', [], 'a:br')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(' ')
}

function shapeText(shape: unknown): string {
  return flatSlideText(shape)
}

/** Text blocks from every table on a slide, one block per row (cells joined with ` | `). A PowerPoint table (`p:graphicFrame` > `a:graphic` > `a:graphicData` > `a:tbl` > `a:tr` > `a:tc`) never uses `p:sp` at all -- slideShapes()'s p:sp-only collection silently drops every table's cell text, even though pptxOutline's bodyChars and pptxTextGrep both already see it (they scan the whole parsed slide tree via collectTextRuns, not slideShapes()). Without this, a real, common slide shape (comparison tables, data grids) is completely absent from pptxSlideText's output -- the one command whose job is showing a slide's actual text -- even though pptx-text-grep can find a match inside it. */
function tableRowBlocks(parsedSlide: unknown): string[] {
  const blocks: string[] = []
  for (const tbl of collectElements(parsedSlide, 'a:tbl')) {
    for (const row of collectElements(tbl, 'a:tr')) {
      const cellTexts = collectElements(row, 'a:tc').map((cell) => flatSlideText(cell))
      const rowText = cellTexts.join(' | ').trim()
      if (rowText.length > 0) blocks.push(rowText)
    }
  }
  return blocks
}

interface RelationshipLike {
  '@_Id'?: string
  '@_Target'?: string
  '@_Type'?: string
}

interface SldIdLike {
  '@_r:id'?: string
}

/** Resolves the deck's actual display order (`ppt/presentation.xml`'s `<p:sldIdLst>`, a list of `r:id` references, resolved to file paths via `ppt/_rels/presentation.xml.rels`) rather than trusting `slideN.xml` filenames, which reflect insertion order and go stale the moment a slide is reordered, duplicated, or deleted -- both very common PowerPoint operations. Returns null when either part is missing/unparseable so the caller can fall back to filename order (e.g. a hand-built or non-standard .pptx). Deduplicates on the resolved target rather than the raw `r:id`: under ECMA-376 each `<p:sldId>` addresses a distinct slide part, so the same resolved part naming a second `<p:sldId>` is not something an authoring tool produces -- it is a hand-built or corrupted `sldIdLst` amplifying every downstream per-slide parse (parseSlide has no cache) by however many times the list repeats it, with no cap on the list length otherwise. First appearance wins, so display order for the parts that do appear once is unaffected. */
async function slidePathsInPresentationOrder(entries: Record<string, Uint8Array>, budget: OoxmlPartBudget): Promise<string[] | null> {
  const presXml = decodeZipEntry(entries, 'ppt/presentation.xml', budget)
  const relsXml = decodeZipEntry(entries, 'ppt/_rels/presentation.xml.rels', budget)
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
  const seen = new Set<string>()
  for (const sldId of collectElements(presParsed, 'p:sldId') as SldIdLike[]) {
    const rid = sldId['@_r:id']
    if (rid === undefined) continue
    const target = ridToTarget.get(rid)
    if (target === undefined) continue
    const normalized = target.startsWith('slides/') ? `ppt/${target}` : `ppt/slides/${target}`
    if (entries[normalized] === undefined || seen.has(normalized)) continue
    seen.add(normalized)
    ordered.push(normalized)
  }

  return ordered.length > 0 ? ordered : null
}

/** Returns the archive's `budget` alongside its entries because this is the function that begins a deck's read: every decode a caller goes on to make -- slide, slide rels, notes -- has to be charged against the one budget this document opened, not against a fresh one per slide, which would bound nothing. */
async function listSlideParts(filePath: string): Promise<{ entries: Record<string, Uint8Array>; slidePaths: string[]; budget: OoxmlPartBudget }> {
  const entries = await readOoxmlZip(filePath, '.pptx')
  const budget = ooxmlPartBudget()
  const slidePaths =
    (await slidePathsInPresentationOrder(entries, budget)) ??
    sortNumberedParts(
      Object.keys(entries).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)),
      /slide(\d+)\.xml$/,
    )
  if (slidePaths.length === 0) throw new NotAnOfficeDocumentError(`no slides found in ${filePath} (not a valid .pptx?)`)
  return { entries, slidePaths, budget }
}

function relsPathFor(slidePath: string): string {
  const idx = slidePath.lastIndexOf('/')
  return `${slidePath.slice(0, idx)}/_rels/${slidePath.slice(idx + 1)}.rels`
}

function resolveRelativeTarget(basePath: string, target: string): string {
  const baseDir = basePath.slice(0, basePath.lastIndexOf('/'))
  const segments = `${baseDir}/${target}`.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join('/')
}

/** Resolves a slide's notes part via its own relationship file (`ppt/slides/_rels/slideN.xml.rels`, a `notesSlide` relationship pointing at the actual notes target) rather than assuming `slideN.xml` pairs with `notesSlideN.xml` -- notes-slide numbering is a separate counter from slide numbering, so duplicating, deleting, or reordering slides can decouple the two. Returns null when the slide has no notesSlide relationship (no notes part exists for it). */
async function notesPathFor(entries: Record<string, Uint8Array>, slidePath: string, budget: OoxmlPartBudget): Promise<string | null> {
  const relsXml = decodeZipEntry(entries, relsPathFor(slidePath), budget)
  if (relsXml === null) return null
  const relsParsed = await parseOoxmlPart(relsXml)
  for (const rel of collectElements(relsParsed, 'Relationship') as RelationshipLike[]) {
    if (rel['@_Target'] !== undefined && rel['@_Type']?.endsWith('/notesSlide') === true) {
      return resolveRelativeTarget(slidePath, rel['@_Target'])
    }
  }
  return null
}

/** PowerPoint keeps an equation in an `a14:m` (Math) element inside an `mc:Choice Requires="a14"` branch, holding an OMML `m:oMathPara` ([MS-ODRAWXML]). Rewriting the math into an `a:r` run leaves that run under `a14:m`, one level below the `a:p` that owns the surrounding runs, which puts it back out of document order against any sibling `a:r`; dropping the wrapper makes it a direct paragraph child. */
function inlineSlideMath(xml: string): string {
  return inlineMathRuns(xml, '<a:r><a:t xml:space="preserve">', '</a:t></a:r>').replace(/<a14:m(?:\s[^>]*)?>/g, '').replace(/<\/a14:m>/g, '')
}

async function parseSlide(entries: Record<string, Uint8Array>, path: string, budget: OoxmlPartBudget): Promise<unknown> {
  const xml = decodeZipEntry(entries, path, budget)
  if (xml === null) throw new Error(`missing part: ${path}`)
  return parseOoxmlPart(inlineSlideMath(xml))
}

/** PowerPoint auto-creates a notesSlideN.xml part for essentially every slide as soon as a deck is saved, whether or not the user ever typed anything into the notes pane -- so mere presence of the ZIP part is not a reliable "this slide has notes" signal. Returns the actual extracted notes body text (empty string if the part is absent or its body placeholder has no text), so callers can check length instead of presence. */
async function notesTextFor(entries: Record<string, Uint8Array>, notesPath: string | null, budget: OoxmlPartBudget): Promise<string> {
  if (notesPath === null) return ''
  const xml = decodeZipEntry(entries, notesPath, budget)
  if (xml === null) return ''
  const parsed = await parseOoxmlPart(inlineSlideMath(xml))
  const shapes = collectElements(parsed, 'p:sp')
  const bodyShape = shapes.find((s) => shapePlaceholderType(s) === 'body')
  return bodyShape !== undefined ? shapeText(bodyShape) : flatSlideText(parsed)
}

export async function pptxOutline(filePath: string, deadline: number = ooxmlWorkDeadline()): Promise<SlideOutlineEntry[]> {
  const { entries, slidePaths, budget } = await listSlideParts(filePath)
  const out: SlideOutlineEntry[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    assertOoxmlWithinDeadline(deadline, 'Narrow the read to specific slides with pptx-slide, or use a smaller deck.')
    const path = slidePaths[i] as string
    const parsed = await parseSlide(entries, path, budget)
    const shapes = slideShapes(parsed)
    const titleShape = shapes.find((s) => {
      const t = shapePlaceholderType(s)
      return t === 'title' || t === 'ctrTitle'
    })
    const title = titleShape !== undefined ? shapeText(titleShape) : ''
    const allText = flatSlideText(parsed)
    const bodyChars = Math.max(0, allText.length - title.length)
    const hasNotes = (await notesTextFor(entries, await notesPathFor(entries, path, budget), budget)).length > 0
    out.push({ slide: i + 1, title, bodyChars, hasNotes })
  }
  return out
}

/** The actual per-slide extraction, given an archive already opened by the caller (listSlideParts's `entries`/`slidePaths`). Split out of pptxSlideText so a bulk walk over every slide (pptxAllSlidesText) can reuse one already-decompressed archive instead of each slide re-triggering listSlideParts's own readOoxmlZip. */
async function slideTextFromParts(entries: Record<string, Uint8Array>, slidePaths: string[], slideNumber: number, includeNotes: boolean, budget: OoxmlPartBudget): Promise<string> {
  if (slideNumber < 1 || slideNumber > slidePaths.length) {
    throw new Error(`slide ${slideNumber} out of range (this deck has ${slidePaths.length} slides)`)
  }
  const path = slidePaths[slideNumber - 1] as string
  const parsed = await parseSlide(entries, path, budget)
  const shapes = slideShapes(parsed)
  const blocks = [...shapes.map(shapeText).filter((t) => t.length > 0), ...tableRowBlocks(parsed)]
  const lines = [`# Slide ${slideNumber}`, ...blocks]
  if (includeNotes) {
    const notes = await notesTextFor(entries, await notesPathFor(entries, path, budget), budget)
    if (notes.length > 0) lines.push('', '## Speaker notes', notes)
  }
  return lines.join('\n\n')
}

export async function pptxSlideText(filePath: string, slideNumber: number, includeNotes: boolean): Promise<string> {
  const { entries, slidePaths, budget } = await listSlideParts(filePath)
  return slideTextFromParts(entries, slidePaths, slideNumber, includeNotes, budget)
}

/** Every slide's text from one archive read, for callers that need the whole deck rather than one slide at a time (the embeddings pipeline via doc_embed_extract.ts). Looping pptxSlideText itself N times used to cost N+1 full archive reads for an N-slide deck -- pptxOutline's own read plus one per slide, each re-running readOoxmlZip's fs.readFileSync-and-unzipBounded from scratch -- because listSlideParts has no cache and nothing bounded how many times a document could make it run. `deadline` defaults to a fresh {@link ooxmlWorkDeadline} so a caller can pass one down across several documents (or its own remaining budget) but doesn't have to. */
export async function pptxAllSlidesText(filePath: string, includeNotes: boolean, deadline: number = ooxmlWorkDeadline()): Promise<string> {
  const { entries, slidePaths, budget } = await listSlideParts(filePath)
  const slideTexts: string[] = []
  for (let i = 1; i <= slidePaths.length; i++) {
    assertOoxmlWithinDeadline(deadline, 'Narrow the read to specific slides with pptx-slide, or use a smaller deck.')
    slideTexts.push(await slideTextFromParts(entries, slidePaths, i, includeNotes, budget))
  }
  return slideTexts.join('\n\n')
}

export async function pptxNotesText(filePath: string, slideNumber?: number, deadline: number = ooxmlWorkDeadline()): Promise<string> {
  const { entries, slidePaths, budget } = await listSlideParts(filePath)
  const targets = slideNumber !== undefined ? [slideNumber] : slidePaths.map((_, i) => i + 1)
  const sections: string[] = []
  for (const n of targets) {
    assertOoxmlWithinDeadline(deadline, 'Narrow the read to one slide with the slide-number argument, or use a smaller deck.')
    if (n < 1 || n > slidePaths.length) throw new Error(`slide ${n} out of range (this deck has ${slidePaths.length} slides)`)
    const notesPath = await notesPathFor(entries, slidePaths[n - 1] as string, budget)
    const text = await notesTextFor(entries, notesPath, budget)
    if (text.length > 0) sections.push(`# Slide ${n} notes\n\n${text}`)
  }
  return sections.join('\n\n')
}

export interface PptxTextMatch {
  slide: number
  snippet: string
}

export async function pptxTextGrep(filePath: string, pattern: string, deadline: number = ooxmlWorkDeadline()): Promise<PptxTextMatch[]> {
  const { entries, slidePaths, budget } = await listSlideParts(filePath)
  const guarded = compileGuardedRegex(pattern, 'i')
  if (!guarded.ok) throw new Error(`invalid --grep pattern: ${pattern} -- the pattern ${guarded.reason}`)
  const re = guarded.re
  const out: PptxTextMatch[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    assertOoxmlWithinDeadline(deadline, 'Narrow the read to specific slides with pptx-slide, or use a smaller deck.')
    const parsed = await parseSlide(entries, slidePaths[i] as string, budget)
    const text = flatSlideText(parsed)
    if (re.test(text)) {
      const idx = text.search(re)
      const snippet = text.slice(Math.max(0, idx - 40), idx + 80).trim()
      out.push({ slide: i + 1, snippet })
    }
  }
  return out
}
