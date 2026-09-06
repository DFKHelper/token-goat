import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planCommentFolds, type CommentSyntax } from '../src/code_fold.js'
import { foldDelivery, isProseFoldablePath, type FoldRow } from '../src/fold_delivery.js'

// Provenance. HAND-DERIVED throughout: every fixture is written from the input side (a template literal holding a `/*`, a paragraph long enough to fold, a log record with a stack trace) and the expectation is computed from what the reader asked for, never from what the planner happens to emit. The template-literal case is the shape found by sweeping this repo's own tree, where `tests/languages.test.ts` folded rows 4393-5155 as "comment lines" of which 598 were executable code, opened by a `/*` inside a SQL template literal and closed 764 rows later inside an unrelated protobuf fixture. No case here asserts a ratio or a byte count: over-folding improves both, so a floor on either would pass on exactly the bug being tested.

const SLASH_STAR: CommentSyntax = { line: ['//'], open: '/*', close: '*/' }

function rows(lines: readonly string[]): { no: number; text: string }[] {
  return lines.map((text, i) => ({ no: i + 1, text }))
}

function deliveryRows(lines: readonly string[], firstLine = 1): FoldRow[] {
  return lines.map((text, i) => ({ no: firstLine + i, raw: `${firstLine + i}\u2192${text}`, text }))
}

describe('a comment fold never swallows code', () => {
  it('leaves a block-comment marker inside a template literal alone', () => {
    const lines = [
      'export const query = `',
      '/* a comment marker that is really SQL inside a template literal',
      'SELECT * FROM t;',
      '`',
      ...Array.from({ length: 30 }, (_, i) => `export function realCode${i}() { return ${i} }`),
      '/* an unrelated real comment far below */',
    ]
    const folds = planCommentFolds(rows(lines), SLASH_STAR, 2, 12, new Set())
    const code = lines.findIndex((l) => l.startsWith('export function realCode0'))
    for (const fold of folds) {
      expect(fold.startIdx + fold.len).toBeLessThanOrEqual(code)
    }
  })

  it('still folds a genuine long block comment', () => {
    const lines = ['const a = 1', '/*', ...Array.from({ length: 20 }, (_, i) => ` * line ${i}`), ' */', 'const b = 2']
    const folds = planCommentFolds(rows(lines), SLASH_STAR, 2, 12, new Set())
    expect(folds.length).toBe(1)
    // The planner keeps the first two rows of the block, so the fold starts after them and ends on the closer.
    expect(folds[0]?.firstLine).toBe(4)
    expect(folds[0]?.lastLine).toBe(23)
  })
})

describe('a prose fold only reaches a format whose structure it can read', () => {
  it('declines the document types it has no rules for', () => {
    expect(isProseFoldablePath('c:/p/readme.md')).toBe(true)
    expect(isProseFoldablePath('c:/p/guide.mdx')).toBe(true)
    expect(isProseFoldablePath('c:/p/server.log.txt')).toBe(false)
    expect(isProseFoldablePath('c:/p/index.rst')).toBe(false)
  })
})

describe('a fold notice points at something it can actually return', () => {
  const paragraph = `The service failed to start. ${'Then a great deal more explanation followed that the reader would rather not pay for. '.repeat(6)}`
  const prevCode = process.env['TOKEN_GOAT_FOLD_CODE_BODIES']
  const prevProse = process.env['TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS']

  beforeAll(() => {
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '1'
    process.env['TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS'] = '1'
  })
  afterAll(() => {
    if (prevCode === undefined) delete process.env['TOKEN_GOAT_FOLD_CODE_BODIES']
    else process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = prevCode
    if (prevProse === undefined) delete process.env['TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS']
    else process.env['TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS'] = prevProse
  })

  it('declines to fold a delivery its own paragraph pointer would ask for', () => {
    // The whole-file read folds, which is the value this feature exists for.
    const whole = foldDelivery(deliveryRows(['# Title', '', paragraph, '', 'tail']), 'c:/p/doc.md', 'doc.md')
    expect(whole).not.toBeNull()
    expect(whole?.numbered.some((l) => l.includes('rest of paragraph folded'))).toBe(true)
    // Running the pointer that notice printed (`offset=3, limit=1`) delivers that one row as a window, and folding it again would print the same notice instead of the paragraph.
    expect(foldDelivery(deliveryRows([paragraph], 3), 'c:/p/doc.md', 'doc.md', true)).toBeNull()
  })

  it('leaves a ranged read alone rather than comment-folding it a second time', () => {
    const block = ['/*', ...Array.from({ length: 20 }, (_, i) => ` * line ${i}`), ' */']
    const whole = foldDelivery(deliveryRows(['const a = 1', ...block, 'const b = 2']), 'c:/p/a.ts', 'a.ts')
    expect(whole).not.toBeNull()
    const notice = whole?.numbered.find((l) => l.includes('more comment lines'))
    expect(notice).toBeDefined()
    // The pointer names the span it removed, which is the block minus the two rows kept above the notice.
    expect(notice).toContain('offset=4, limit=20')
    // A reader who asks for a range has already narrowed the read themselves, which is the rule commentFoldNotice states and the fold now honours.
    expect(foldDelivery(deliveryRows(block, 2), 'c:/p/a.ts', 'a.ts', true)).toBeNull()
  })
})
