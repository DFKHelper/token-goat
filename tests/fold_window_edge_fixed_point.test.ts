import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Fixture provenance: HAND-DERIVED. The rows are synthetic files written to satisfy the documented
// thresholds (a block of at least COMMENT_FOLD_MIN_BLOCK comment lines; a paragraph past the prose
// planner's character floor whose opening sentence ends early enough to keep). That is the right
// strength here because what is under test is a gating decision plus an arithmetic property of row
// positions, not a wire format. The comment fold's recall RANGE is not hand-written: it is parsed
// out of the notice the planner itself emitted, so the second window is exactly what a reader
// following that notice would ask for rather than a range this test believes the notice contains.
// The prose fold's recall is not a range at all -- it names a `token-goat section` heading, resolved
// via readSection against the real fixture file written to disk for that purpose.
//
// Which fold carries the fixed point was established by measurement, not by reading the old comment.
// `foldDelivery` used to decline every window on the stated grounds that both notices point at a
// ranged Read of their own span, so a recall would re-fold and hand back less than the notice
// promised. That is true of the PROSE fold, whose pointer is `limit=1` on the very row it folded.
// It is false of the COMMENT fold: the recall range begins after the kept `/**` and summary line, and
// `planCommentFolds` needs an opening marker to enter a block, so the recalled rows are not a
// comment run at all and fold to nothing. The first version of this test asserted the fixed point on
// the comment fold and its positive control failed, which is how the difference surfaced.

const enqueueDirtyPathSafe = vi.fn()
const getFileEntry = vi.fn()
const querySymbols = vi.fn(() => [])
const fingerprintFile = vi.fn(() => 'sha-does-not-matter')

vi.mock('../src/hooks_index.js', () => ({ enqueueDirtyPathSafe }))
vi.mock('../src/index_reader.js', () => ({ getFileEntry, querySymbols, DEFAULT_QUERY_LIMIT: 100 }))
// Spread the real module: project.ts reaches for shortFingerprint from here on every loadConfig, so replacing the whole module leaves config resolution with an undefined function.
vi.mock('../src/fingerprint.js', async (actual) => ({ ...(await actual<Record<string, unknown>>()), fingerprintFile }))

const { foldDelivery, COMMENT_FOLD_MIN_BLOCK } = await import('../src/fold_delivery.js')
const { readSection } = await import('../src/section_reader.js')

interface Row { no: number, text: string, raw: string }

const PARAGRAPH = 'This opening sentence is complete and short enough to keep. ' + 'Everything after it is elaboration that a reader can defer without losing the point of the paragraph, and it runs well past the planner character floor so the fold has something worth replacing. '.repeat(3)

/** A document whose only foldable feature is one over-long paragraph, sitting away from both ends. */
function docLines(): string[] {
  return ['# Title', '', 'Short line.', '', PARAGRAPH, '', 'Another short line.', '', 'And a third.']
}

/** A .ts file with a long comment block sitting away from both ends, so a window can hold it strictly inside. */
function sourceLines(): string[] {
  const lines: string[] = []
  for (let i = 0; i < 8; i++) lines.push(`const before${i} = ${i}`)
  lines.push('/**', ' * Opening summary sentence a reader navigates by.')
  for (let i = 0; i < COMMENT_FOLD_MIN_BLOCK + 4; i++) lines.push(` * elaboration line ${i} that the fold is expected to replace`)
  lines.push(' */')
  for (let i = 0; i < 8; i++) lines.push(`const after${i} = ${i}`)
  return lines
}

/** Delivered rows for the inclusive 1-based line range [from, to], as a windowed read produces them. */
function windowOf(all: string[], from: number, to: number): Row[] {
  const out: Row[] = []
  for (let no = from; no <= to; no++) out.push({ no, text: all[no - 1] ?? '', raw: `${no}\t${all[no - 1] ?? ''}` })
  return out
}

/** A prose fold now folds a paragraph only when findContainingSection can resolve an enclosing heading for it, and that lookup reads the real file off disk rather than the in-memory `rows` a test hands `foldDelivery` -- a synthetic, never-written path (as the doc.md fixtures below used to pass) always resolves to no section and so never folds. Writes `lines` to a real temp file and returns its path so the two doc.md prose-fold cases below exercise a real, resolvable heading the same way a live Read of an actual document would. */
function writeMarkdownFixture(lines: readonly string[]): string {
  const file = path.join(os.tmpdir(), `tg-window-edge-doc-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(file, lines.join('\n'))
  return file
}

describe('a windowed read folds interior blocks, and a recall of such a fold is not a fixed point', () => {
  const saved: Record<string, string | undefined> = {}
  const keys = ['TOKEN_GOAT_FOLD_CODE_BODIES', 'TOKEN_GOAT_FOLD_COMMENT_BLOCKS', 'TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS']
  const tmpFiles: string[] = []

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k]
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '0'
    process.env['TOKEN_GOAT_FOLD_COMMENT_BLOCKS'] = '1'
    process.env['TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS'] = '1'
    vi.clearAllMocks()
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        // best effort
      }
    }
  })

  it('folds a comment block that sits strictly inside the window, which is the capability the edge rule buys', () => {
    const all = sourceLines()
    const folded = foldDelivery(windowOf(all, 1, all.length), 'C:/proj/sample.ts', 'sample.ts', true)

    expect(folded).not.toBeNull()
    expect(folded?.folds.map((f) => f.kind)).toEqual(['comment'])
    // Must-not-drop: a ratio or count assertion alone is satisfied by collapsing the whole block, which is the failure this fold exists to avoid.
    expect(folded?.numbered.join('\n')).toContain('Opening summary sentence a reader navigates by.')
  })

  it('folds an over-long paragraph that sits strictly inside the window', () => {
    const all = docLines()
    const file = writeMarkdownFixture(all)
    tmpFiles.push(file)
    const folded = foldDelivery(windowOf(all, 1, all.length), file, 'doc.md', true)

    expect(folded).not.toBeNull()
    expect(folded?.folds.map((f) => f.kind)).toEqual(['prose'])
    expect(folded?.numbered.join('\n')).toContain('This opening sentence is complete and short enough to keep.')
  })

  it('folds nothing when handed exactly the single row its own prose notice pointed at, so following the notice returns the paragraph', () => {
    const all = docLines()
    const file = writeMarkdownFixture(all)
    tmpFiles.push(file)
    const wide = foldDelivery(windowOf(all, 1, all.length), file, 'doc.md', true)
    const notice = wide?.numbered.find((l) => l.includes('rest of paragraph folded'))
    expect(notice).toBeDefined()

    // The notice now points at `token-goat section "doc.md::Title"` rather than a ranged Read: the paragraph resolves to the `# Title` heading above it in the real file just written. Recall via readSection instead of a synthetic offset/limit window.
    expect(notice).toContain('token-goat section "doc.md::Title"')
    const section = readSection(file, 'Title')
    expect(section?.content).toContain(PARAGRAPH)

    // POSITIVE CONTROL, and the reason this test is not vacuous. This exact row DOES fold when it is not a window, so the null below is the edge filter refusing to re-fold a recall, never "there was nothing foldable here anyway". Without this, deleting the prose planner outright would leave the assertion green.
    const paragraphLine = all.findIndex((l) => l === PARAGRAPH) + 1
    const singleRow = windowOf(all, paragraphLine, paragraphLine)
    const asWholeFile = foldDelivery(singleRow, file, 'doc.md', false)
    expect(asWholeFile).not.toBeNull()
    expect(asWholeFile?.folds.map((f) => f.kind)).toEqual(['prose'])

    expect(foldDelivery(singleRow, file, 'doc.md', true)).toBeNull()
  })

  it('leaves a fold touching the last delivered row alone, since a window ending mid-block cannot promise what follows it', () => {
    const all = sourceLines()
    const blockStart = all.findIndex((l) => l === '/**') + 1
    // Cut the window off inside the comment block, so the block runs to the final delivered row.
    const rows = windowOf(all, blockStart - 2, blockStart + COMMENT_FOLD_MIN_BLOCK + 2)
    expect(rows[rows.length - 1]?.text.startsWith(' * elaboration')).toBe(true)

    expect(foldDelivery(rows, 'C:/proj/sample.ts', 'sample.ts', true)).toBeNull()
  })
})
