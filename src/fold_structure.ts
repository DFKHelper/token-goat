/**
 * Turning a whole-file delivery into a structural view of it: a heading tree for a document, a declaration skeleton for source.
 *
 * Split out of hooks_read.ts for the same reason fold_delivery.ts was, and with the same division of labour. The two surfaces that deliver a whole file gate very differently -- a Read arrives as a numbered rendering with an offset/limit the harness reports, a shell read arrives as the bare stdout of a command that has to be recognised as a whole-file read before any of this applies -- but everything between "here are the delivered rows" and "here is the structural replacement" is identical, and that middle is where the size floors, the count floors and the notice wording live. One copy, so a change to either reaches both.
 *
 * Everything here is built from the DELIVERED text, never the index. That is what lets it serve a first read of a file the indexer has never touched, and what keeps it working where fold_delivery.ts's body fold cannot: measured on a real index, the parser stamp sits stale on 95% of this project's own rows, and a stale row yields no spans at all.
 */
import { foldDelivery, isProseFoldablePath, type FoldRow } from './fold_delivery.js'
import { bodyFoldNotice } from './fold_delivery.js'
import { loadConfig } from './config.js'
import { extractMarkdownHeadings, formatHeadingTreeParts, type MarkdownHeading } from './hints/markdown_hints.js'
import { fenceUntrustedFileContent } from './injection_scan.js'
import { isTreeSitterAvailable, parseSourceSymbolsTreeSitterOnly } from './parser.js'
import { detectLanguage } from './parser_types.js'
import type { SymbolEntry } from './parser_types.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

/** Body size floor for the large-markdown outline replacement below: measured over 5,104 real session transcripts (13,870 Read deliveries, 130,249,204 bytes), untargeted markdown reads with >=6 headings at this floor withhold 41.03% of all Read bytes, within 1.8 points of the best floor sampled (2,000 B) while firing far less often on documents small enough that the interruption outweighs the win. */
export const OUTLINE_MIN_BODY_BYTES = 8_000
/** Heading-count floor: at the 8,000 B body floor, sensitivity ran >=2 43.35%, >=4 42.95%, >=6 41.03%, >=10 29.15%, >=15 18.66% -- six is the knee, costing about 2 points against >=4 in exchange for a real guarantee the tree is worth showing rather than a stub of one or two entries. */
export const OUTLINE_MIN_HEADINGS = 6
/** The replacement must land at or under this fraction of the original body, on top of the generic isRewriteWorthwhile floor below -- a document that just barely clears the size and heading gates but whose tree is nearly as large as the body it replaces is not worth the interruption. Evaluated against the FULL replacement, lead-in included, never the smaller heading-tree-only shape, or a document could pass a gate for output it no longer produces. */
export const OUTLINE_MAX_REPLACEMENT_RATIO = 0.4
/** Hard byte cap on the lead-in kept ahead of the heading tree, applied before the prose fold below gets a chance to shrink it further. Sized from the same corpus this feature was measured against: median section 1,014 B, mean 2,127 B, p90 4,225 B -- a cap at p90 keeps the common case (and the median by a wide margin) whole while bounding the rare oversized one. */
export const OUTLINE_LEADIN_MAX_BYTES = 4_225

/** Body size floor for the structural-skeleton replacement. Measured over 5,104 real session transcripts (130,325,670 delivered Read bytes): 1,023 untargeted source reads land above 8 KB, and pairing this 12,000 B floor with the 8-symbol floor below leaves 558 of them, a 12,349,858 B pool from which the fold withholds 11,241,796 B, 8.63% of all Read bytes. Set above the 8,000 B markdown floor on purpose: a source file that small is usually one unit of work a reader wanted whole, and the skeleton of it saves little. */
export const SKELETON_MIN_BODY_BYTES = 12_000
/** Declaration-count floor. A skeleton is a map, and a map of three things is not worth the round trip it costs to get any of them back: the same corpus puts the median symbol body at 4.11% of its file, so break-even sits near 22 bodies pulled back out of an average 30.8, and a file with only a handful of declarations has no room above that line. */
export const SKELETON_MIN_SYMBOLS = 8
/** The rendered skeleton must land at or under this fraction of the delivered body, on top of the generic isRewriteWorthwhile floor. Same value and same reason as OUTLINE_MAX_REPLACEMENT_RATIO above: a file whose declarations are nearly all of it (a long type or constant table) clears the size and symbol gates while its skeleton saves nothing, and shipping that is a partial view sold as an optimisation. */
export const SKELETON_MAX_REPLACEMENT_RATIO = 0.4

/**
 * A planned structural replacement, carrying the same deliberately non-parallel pair {@link FoldedDelivery} does.
 *
 * `numbered` goes to the model and holds a notice in place of each withheld run; `raw` goes to the served-output store and holds neither the withheld lines nor the notices, so a line this fold withheld is never later elided as already seen. `kind` and `detail` are the stats labels the caller passes straight to `emitRewrite`, kept here so the two surfaces cannot drift into labelling the same rewrite differently.
 */
export interface StructuralFold {
  readonly numbered: string[]
  readonly raw: string[]
  readonly kind: 'read:markdown_outline' | 'read:source_skeleton'
  readonly detail: string
  readonly ratioCap: number
}

/**
 * The lead-in a large-document outline keeps ahead of its heading tree: the document body up to its first second-level (`##`) heading when it opens with an H1, or -- when it does not, so there is no "everything under the H1" region to speak of -- the body up to its very first heading of any level, same as before this lead-in concept existed. Either way this is what a reader loses if it goes unkept: the paragraph that says what the document is.
 *
 * `headings[0]` rather than a scan is enough to tell which case applies: `extractMarkdownHeadings` returns headings in document order, so the very first entry is either the leading H1 or it is not.
 */
function outlineLeadInRows(rows: readonly FoldRow[], headings: readonly MarkdownHeading[]): FoldRow[] {
  const opensWithH1 = headings[0]?.level === 1
  const boundary = opensWithH1 ? headings.find((h, i) => i > 0 && h.level === 2) : headings[0]
  if (boundary === undefined) return []
  const boundaryIdx = rows.findIndex((r) => r.no === boundary.lineNumber)
  return boundaryIdx > 0 ? rows.slice(0, boundaryIdx) : []
}

/**
 * Cap `rows` to `OUTLINE_LEADIN_MAX_BYTES`, cutting at a row boundary rather than mid-line, and returning a notice disclosing the cut in place -- never a silent trim. Rows past the cap are dropped from the return value entirely, so they cannot leak into `foldDelivery`'s prose fold or the served-output record below.
 */
function capLeadIn(rows: readonly FoldRow[], shownPath: string): { rows: FoldRow[]; notice: string | null } {
  let bytes = 0
  let cutAt = rows.length
  for (let i = 0; i < rows.length; i++) {
    bytes += Buffer.byteLength(rows[i]!.text, 'utf-8') + 1
    if (bytes > OUTLINE_LEADIN_MAX_BYTES) {
      cutAt = i
      break
    }
  }
  if (cutAt >= rows.length) return { rows: [...rows], notice: null }
  const kept = rows.slice(0, cutAt)
  const cutFrom = rows[cutAt]!.no
  const cutTo = rows[rows.length - 1]!.no
  const n = cutTo - cutFrom + 1
  return {
    rows: kept,
    notice: `... ${n} more lead-in line${n === 1 ? '' : 's'} (${cutFrom}-${cutTo}) cut at the ${OUTLINE_LEADIN_MAX_BYTES} B lead-in cap -- Read "${shownPath}" with offset=${cutFrom}, limit=${n}`,
  }
}

/**
 * Plan the heading-tree replacement of a large, untargeted markdown delivery, so a reader who wanted the whole document's prose still gets pointed at each section by name instead of losing it outright.
 *
 * `extractMarkdownHeadings` already skips `#` inside a fenced code block via `eachUnfencedLine`, so a fence never gets mistaken for a heading here.
 *
 * Returns null on a path that is not prose, a document under the size floor, or one with too few headings. The caller owns the gates only it can see: whether the read was targeted, whether the delivery was truncated, and whether the body holds a secret.
 */
export function planMarkdownOutline(rows: readonly FoldRow[], normalizedPath: string, shownPath: string, originalBytes: number): StructuralFold | null {
  if (!loadConfig().hints.outline_large_documents) return null
  if (!isProseFoldablePath(normalizedPath)) return null
  if (originalBytes < OUTLINE_MIN_BODY_BYTES) return null

  const fileText = rows.map((r) => r.text).join('\n')
  const headings = extractMarkdownHeadings(fileText)
  if (headings.length < OUTLINE_MIN_HEADINGS) return null

  const { guidance, sectionsList } = formatHeadingTreeParts(headings, shownPath)

  const leadInRows = outlineLeadInRows(rows, headings)
  const { rows: cappedLeadIn, notice: capNotice } = capLeadIn(leadInRows, shownPath)
  // Fed through the same prose fold every other document read gets, rather than exempting the lead-in from it: a long-but-under-cap lead-in still gets its over-long paragraphs folded to their opening sentence. `windowed=false` is correct here regardless of the outer read's own range (already declined by the caller) -- this is a fold of the lead-in slice itself, not of the file at large.
  const leadInFolded = foldDelivery(cappedLeadIn, normalizedPath, shownPath, false)
  const leadInNumbered = leadInFolded !== null ? leadInFolded.numbered : cappedLeadIn.map((r) => r.raw)
  const leadInRaw = leadInFolded !== null ? leadInFolded.raw : cappedLeadIn.map((r) => r.text)

  // headings.length is a floor, not a total: extractMarkdownHeadings caps display extraction at 40 entries and H1-H3 only, so a document with more headings or deeper nesting reports fewer than it actually has. Disclosed as "at least" for that reason, never as an exact count. The lead-in clause is worded from what the rewrite actually kept: claiming "its lead-in" when leadInRows came back empty would be a claim the output does not support.
  const headingCount = `at least ${headings.length} heading${headings.length === 1 ? '' : 's'} found`
  const notice =
    leadInRows.length > 0
      ? `Partial view: this ${originalBytes.toLocaleString('en-US')} B document was replaced with its lead-in (the content before its first section) and a heading tree (${headingCount}). Run token-goat section "${shownPath}::<Heading>" to read one section verbatim.`
      : `Partial view: this ${originalBytes.toLocaleString('en-US')} B document has no lead-in before its first section, so it was replaced with a heading tree alone (${headingCount}). Run token-goat section "${shownPath}::<Heading>" to read one section verbatim.`

  return {
    numbered: [...leadInNumbered, ...(capNotice !== null ? [capNotice] : []), notice, guidance, fenceUntrustedFileContent(sectionsList)],
    raw: leadInRaw,
    kind: 'read:markdown_outline',
    detail: shownPath,
    ratioCap: OUTLINE_MAX_REPLACEMENT_RATIO,
  }
}

/**
 * The line standing in for a withheld run the skeleton cannot name a symbol for: the interior of a class between its methods, top-level statements between declarations, a trailing block after the last symbol.
 *
 * There is no `token-goat read "file::symbol"` that returns such a run, so the pointer is a ranged Read of the exact span, worded to match {@link commentFoldNotice} rather than inventing a fourth shape. A ranged read is also the one shape this fold never touches (ranged reads are declined outright by both callers), so the pointer cannot loop back into another skeleton.
 */
function skeletonGapNotice(firstLine: number, lastLine: number, shownPath: string): string {
  const n = lastLine - firstLine + 1
  return `... ${n} line${n === 1 ? '' : 's'} (${firstLine}-${lastLine}) withheld from the skeleton -- Read "${shownPath}" with offset=${firstLine}, limit=${n}`
}

/** A planned skeleton. `withheldLines` counts what the notices stand for, for the disclosure. */
interface SkeletonPlan {
  readonly numbered: string[]
  readonly raw: string[]
  readonly withheldLines: number
}

/**
 * Keep the file's preamble and one line per declaration, replace every run between them with a notice.
 *
 * A run that exactly spans one symbol's body (the line after its declaration through its last line) gets {@link bodyFoldNotice}, which names the symbol and the command that returns it. Every other run gets {@link skeletonGapNotice}, which names a ranged Read of the same span. Nothing is dropped without one of the two standing in its place: a skeleton whose omissions are invisible is worse than the file it replaced, because the reader cannot tell what is missing.
 *
 * A run whose notice would cost at least as many bytes as the lines it replaces is left verbatim instead. That is not a rounding detail: without it, every blank line between two declarations becomes an 80-byte pointer to a blank line, and the ratio gate would start declining files the fold should have shrunk.
 *
 * Returns null when nothing was withheld, so a file whose declarations are already every line it has is delivered as it arrived rather than as an identical copy with a "partial view" notice on it.
 */
function planSourceSkeletonRuns(rows: readonly FoldRow[], symbols: readonly SymbolEntry[], shownPath: string): SkeletonPlan | null {
  const base = rows[0]?.no ?? 1
  const keep = new Set<number>()
  // The preamble is every line ahead of the first declaration: imports, a package or module clause, the file's header comment. It is what says how to read the declarations that follow, and it is the part of a source file a skeleton is least able to reconstruct.
  const firstDeclLine = Math.min(...symbols.map((s) => s.lineStart))
  for (let n = base; n < firstDeclLine; n++) keep.add(n)
  for (const sym of symbols) keep.add(sym.lineStart)

  // Keyed on the line a body starts, which is the only line a withheld run can begin at for the run to be that symbol's body and nothing else. A single-line symbol has no body run and never enters this map.
  const bodyRunStart = new Map<number, SymbolEntry>()
  for (const sym of symbols) if (sym.lineEnd > sym.lineStart) bodyRunStart.set(sym.lineStart + 1, sym)
  // A withheld run also ends at the last line of any symbol it covers, not only at the next kept line. Without this the blank line between two functions joins the first one's body into a single run, which then matches no symbol exactly and loses the `token-goat read "file::symbol"` pointer for the body it is mostly made of.
  const runEndsAfter = new Set<number>()
  for (const sym of symbols) if (sym.lineEnd > sym.lineStart) runEndsAfter.add(sym.lineEnd)

  const numbered: string[] = []
  const raw: string[] = []
  let withheldLines = 0
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row === undefined) break
    if (keep.has(row.no)) {
      numbered.push(row.raw)
      raw.push(row.text)
      i++
      continue
    }
    let j = i
    while (j < rows.length && !keep.has(rows[j]?.no ?? -1)) {
      const stop = runEndsAfter.has(rows[j]?.no ?? -1)
      j++
      if (stop) break
    }
    const firstLine = row.no
    const lastLine = rows[j - 1]?.no ?? firstLine
    const sym = bodyRunStart.get(firstLine)
    const notice = sym !== undefined && sym.lineEnd === lastLine ? bodyFoldNotice(sym.name, firstLine, lastLine, shownPath) : skeletonGapNotice(firstLine, lastLine, shownPath)
    let runBytes = 0
    for (let k = i; k < j; k++) runBytes += Buffer.byteLength(rows[k]?.raw ?? '', 'utf-8') + 1
    if (Buffer.byteLength(notice, 'utf-8') >= runBytes) {
      for (let k = i; k < j; k++) {
        const kept = rows[k]
        if (kept === undefined) continue
        numbered.push(kept.raw)
        raw.push(kept.text)
      }
    } else {
      numbered.push(notice)
      withheldLines += lastLine - firstLine + 1
    }
    i = j
  }
  return withheldLines === 0 ? null : { numbered, raw, withheldLines }
}

/**
 * Plan the structural-skeleton replacement of a large, untargeted source delivery, so a reader who asked for a whole file still gets every declaration by name with a command that returns any one body verbatim.
 *
 * The extension gate is the language table plus the grammar check the parser itself uses, rather than a second list of extensions that could drift from it: a language this answers true for is exactly a language the parse can succeed on.
 *
 * Returns null on a language with no grammar, a body under the size floor, a parse failure, too few declarations, or a file whose declarations are already every line it has. The caller owns the gates only it can see: whether the read was targeted, whether the delivery was truncated, and whether the body holds a secret.
 */
export function planSourceSkeleton(rows: readonly FoldRow[], normalizedPath: string, shownPath: string, originalBytes: number): StructuralFold | null {
  if (!loadConfig().hints.skeleton_large_sources) return null
  if (originalBytes < SKELETON_MIN_BODY_BYTES) return null

  const language = detectLanguage(normalizedPath)
  if (!isTreeSitterAvailable(language)) return null

  const fileText = rows.map((r) => r.text).join('\n')
  const symbols = parseSourceSymbolsTreeSitterOnly(fileText, normalizedPath, language)
  if (symbols === null) return null
  if (symbols.length < SKELETON_MIN_SYMBOLS) return null

  const plan = planSourceSkeletonRuns(rows, symbols, shownPath)
  if (plan === null) return null

  // "at least", never an exact count: these are the declarations tree-sitter surfaces as symbols, which is not every name in the file (a local, a nested closure, a declaration inside a body the extractors deliberately skip), so the number is a floor on what the file holds and the wording has to say so. The withheld-line count IS exact, being what the notices below it stand for, and no claim is made about how much of the file a reader recovers.
  const notice = `Partial view: this ${originalBytes.toLocaleString('en-US')} B source file was replaced with its structural skeleton, its preamble and one line per declaration, with ${plan.withheldLines.toLocaleString('en-US')} line${plan.withheldLines === 1 ? '' : 's'} of bodies withheld (at least ${symbols.length} declaration${symbols.length === 1 ? '' : 's'} found). Run token-goat read "${shownPath}::SymbolName" for one body verbatim, or Read "${shownPath}" with offset=1, limit=${rows.length} for the whole file.`

  return { numbered: [notice, ...plan.numbered], raw: plan.raw, kind: 'read:source_skeleton', detail: shownPath, ratioCap: SKELETON_MAX_REPLACEMENT_RATIO }
}

/**
 * The shared acceptance gate both structural folds pass through: the fold's own ratio cap on top of the generic net-benefit floor every rewrite in the codebase answers to.
 *
 * Kept beside the planners rather than at each call site so the two surfaces cannot price the same rewrite differently -- a Bash read and a Read of identical bytes either both ship the skeleton or both decline it.
 */
export function isStructuralRewriteAccepted(originalBytes: number, rewrittenBytes: number, ratioCap: number): boolean {
  if (rewrittenBytes > originalBytes * ratioCap) return false
  return isRewriteWorthwhile({ originalBytes, rewrittenBytes, noticeBytes: 0, minNetSavingsBytes: resolveMinNetSavingsBytes() })
}
