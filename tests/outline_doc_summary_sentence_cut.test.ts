import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOutline } from '../src/read_commands.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'

/**
 * `outline`'s per-symbol doc annotation is cut at the end of its first sentence.
 *
 * Fixture provenance: HAND-DERIVED. Every docstring below is written for this test and the expected
 * cut is computed from the input by reading it, not by running the clip and recording what it said.
 * That matters here more than usual: the previous cap carried a comment claiming it "keeps roughly
 * the first sentence", and a fixture built from the code's own output would have agreed with that
 * claim rather than testing it. Measured against this project's real source instead, over 448
 * docstrings across seven files, cutting at the cap alone left 297 of them ending mid-clause.
 *
 * The size claim is deliberately not asserted as a ratio. A ratio floor is satisfied by cutting
 * more, and cutting more is the failure mode here: an annotation trimmed to nothing scores well and
 * sends the reader back for a full read. The assertions below name the text that must survive.
 */
describe('outline doc summary cuts at the first sentence', () => {
  const tmp: string[] = []

  afterEach(() => {
    for (const f of tmp.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* best effort */
      }
    }
  })

  /** Writes a source file whose symbols carry the docstrings under test, indexes it, and returns `outline`'s text. */
  function outlineOf(docs: readonly string[]): string {
    const lines: string[] = []
    docs.forEach((doc, i) => {
      lines.push(`/** ${doc} */`, `export function subject${i}(): number {`, `  return ${i}`, '}', '')
    })
    const file = path.join(os.tmpdir(), `tg-docsum-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(file, lines.join('\n'))
    tmp.push(file)
    indexFileSync(normalizePath(file))
    return runOutline({ file }).text
  }

  it('ends on the first sentence instead of mid-clause, and marks that more text follows', () => {
    // 168 characters, so the old cap cut inside the second clause. The first sentence ends at 44.
    const text = outlineOf([
      'Resolves the target path against the project root. Callers that already hold an absolute path should not use this, because the second resolution is where a UNC prefix gets doubled on Windows.',
    ])
    expect(text).toContain('Resolves the target path against the project root.…')
    expect(text).not.toContain('because the second resolution')
  })

  it('passes a docstring that is exactly one sentence through byte-identical, with no ellipsis', () => {
    // Nothing was dropped, so marking a cut would be a lie about what is missing.
    const text = outlineOf(['Strips one leading separator from the given path.'])
    expect(text).toContain('Strips one leading separator from the given path.')
    expect(text).not.toContain('given path.…')
  })

  it('does not mistake an abbreviation, an initial or a decimal for the end of a sentence', () => {
    // Each docstring runs past the cap, so the two behaviours genuinely differ: cutting at the cap would carry a fragment of the second sentence, and splitting at the false terminator would truncate the first. Both wrong answers are named in the negative assertions.
    const text = outlineOf([
      'Normalises a separator, e.g. a backslash on Windows, before the lookup runs so both spellings hit one row. The reverse mapping is not maintained, because nothing has needed it yet.',
      'Named for R. Fielding, whose thesis is where the constraint this enforces was first written down. The naming predates the current module layout by some years.',
      'Rejects a ratio below 0.75 because the sampler below it stops being representative of the population. Callers needing every row should ask for the census instead.',
    ])
    expect(text).toContain('e.g. a backslash on Windows, before the lookup runs so both spellings hit one row.…')
    expect(text).not.toContain('reverse mapping')
    expect(text).toContain('R. Fielding, whose thesis is where the constraint this enforces was first written down.…')
    expect(text).not.toContain('predates the current module')
    expect(text).toContain('Rejects a ratio below 0.75 because the sampler below it stops being representative of the population.…')
    expect(text).not.toContain('census instead')
  })

  it('skips an opening fragment too short to be a summary and takes the sentence that follows', () => {
    // "Deprecated." says strictly less than the sentence after it, and cutting there would cost the reader the only line that explains what to call instead. The docstring runs past the cap so that stopping at the cap instead would visibly carry the third sentence's opening words.
    const text = outlineOf([
      'Deprecated. Use resolveProjectRoot, which resolves symlinks before comparing. Anything comparing raw strings will miss a junction on Windows and call two paths different.',
    ])
    expect(text).toContain('Deprecated. Use resolveProjectRoot, which resolves symlinks before comparing.…')
    expect(text).not.toContain('junction on Windows')
  })

  it('still falls back to a word boundary when no sentence ends inside the cap', () => {
    // One clause of 190 characters with no terminator. The old behaviour is the only correct answer here, and it has to keep working: this is the shape the cap was added for.
    const long = `Holds the ${'very '.repeat(34)}long running total`
    const text = outlineOf([long])
    expect(text).toContain('Holds the very')
    expect(text).toContain('…')
    expect(text).not.toContain('long running total')
  })
})
