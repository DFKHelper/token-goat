import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Fixture provenance: HAND-DERIVED. The rows below are a synthetic file written by hand to satisfy the
// documented thresholds (a block of at least COMMENT_FOLD_MIN_BLOCK comment lines, of which
// COMMENT_FOLD_KEEP_LINES survive), not captured from a run and not read off the planner's own source.
// That is the right strength here because what is under test is the gating decision -- which setting
// admits which fold, and which lookups a disabled fold must not perform -- rather than any wire format.

const enqueueDirtyPathSafe = vi.fn()
const getFileEntry = vi.fn()
const querySymbols = vi.fn(() => [])
const fingerprintFile = vi.fn(() => 'sha-does-not-matter')

vi.mock('../src/hooks_index.js', () => ({ enqueueDirtyPathSafe }))
vi.mock('../src/index_reader.js', () => ({ getFileEntry, querySymbols, DEFAULT_QUERY_LIMIT: 100 }))
// Spread the real module: project.ts reaches for shortFingerprint from here on every loadConfig, so replacing the whole module leaves config resolution with an undefined function.
vi.mock('../src/fingerprint.js', async (actual) => ({ ...(await actual<Record<string, unknown>>()), fingerprintFile }))

const { foldDelivery, COMMENT_FOLD_MIN_BLOCK, COMMENT_FOLD_KEEP_LINES } = await import('../src/fold_delivery.js')

/** A .ts file whose only foldable feature is one long comment block, so a fold in the result can only have come from the comment planner. */
function rowsWithOneLongComment(): Array<{ no: number, text: string, raw: string }> {
  const lines = ['/**', ' * Opening summary sentence a reader navigates by.']
  for (let i = 0; i < COMMENT_FOLD_MIN_BLOCK + 4; i++) lines.push(` * elaboration line ${i} that the fold is expected to replace`)
  lines.push(' */', 'export const value = 1')
  return lines.map((text, i) => ({ no: i + 1, text, raw: `${i + 1}\t${text}` }))
}

describe('comment folding is gated on its own setting, not on the body fold', () => {
  const saved: Record<string, string | undefined> = {}
  const keys = ['TOKEN_GOAT_FOLD_CODE_BODIES', 'TOKEN_GOAT_FOLD_COMMENT_BLOCKS', 'TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS']

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k]
    vi.clearAllMocks()
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
  })

  it('folds a long comment block while body folding is off, since the block boundaries come from the delivered text and need no index', () => {
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '0'
    process.env['TOKEN_GOAT_FOLD_COMMENT_BLOCKS'] = '1'

    const rows = rowsWithOneLongComment()
    const folded = foldDelivery(rows, 'C:/proj/sample.ts', 'sample.ts')

    expect(folded).not.toBeNull()
    expect(folded?.folds.map((f) => f.kind)).toEqual(['comment'])
    // The kept head must survive: a ratio assertion alone would be satisfied by dropping the whole block,
    // which is the failure this fold exists to avoid.
    expect(folded?.numbered.join('\n')).toContain('Opening summary sentence a reader navigates by.')
    expect(folded?.numbered.length).toBeLessThan(rows.length)
    expect(COMMENT_FOLD_KEEP_LINES).toBeGreaterThan(0)
  })

  it('leaves the block alone when only its own setting is off, even with body folding on', () => {
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '1'
    process.env['TOKEN_GOAT_FOLD_COMMENT_BLOCKS'] = '0'
    getFileEntry.mockReturnValue(null)

    const rows = rowsWithOneLongComment()
    expect(foldDelivery(rows, 'C:/proj/sample.ts', 'sample.ts')).toBeNull()
  })

  it('does not touch the index or the reindex queue when body folding is off, so a stock install pays nothing for spans it cannot use', () => {
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '0'
    process.env['TOKEN_GOAT_FOLD_COMMENT_BLOCKS'] = '1'

    foldDelivery(rowsWithOneLongComment(), 'C:/proj/sample.ts', 'sample.ts')

    // Without the guard this path hashed the whole file, queried the index, and -- on the common stale-stamp
    // miss -- appended the file to the dirty queue on every single read, all to build spans the disabled body
    // planner then discarded.
    expect(enqueueDirtyPathSafe).not.toHaveBeenCalled()
    expect(getFileEntry).not.toHaveBeenCalled()
    expect(fingerprintFile).not.toHaveBeenCalled()
  })
})
