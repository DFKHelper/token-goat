/**
 * Regression: `section "file::A, B"` treated every comma in the heading as the multi-heading
 * grammar, so a heading whose real text contains a comma could never be read.
 *
 * With `## Setup`, `## Teardown` and `## Setup, Teardown` all present, asking for the combined
 * heading split into two sub-lookups and returned the two unrelated single sections with exit 0.
 * The requested section's body never appeared and nothing in the output said so.
 *
 * Why didn't a test catch this: the multi-heading tests in tests/read_commands.test.ts mock
 * section_reader entirely (`readSection` is an exact key lookup into the test's own map, and
 * `listSections` returns []), so no fixture there has ever had a comma inside a heading and the
 * split could never resolve to something wrong. This file drives the real files-on-disk pipeline.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runSection } from '../src/read_commands.js'

let tmpDir: string
let mdFile: string

const DOC = [
  '# Title',
  '',
  '## Setup',
  '',
  'setup only',
  '',
  '## Teardown',
  '',
  'teardown only',
  '',
  '## Setup, Teardown',
  '',
  'the combined body',
  '',
].join('\n')

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tg-commaheading-'))
  mdFile = join(tmpDir, 'doc.md')
  writeFileSync(mdFile, DOC)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('section with a comma inside the heading text', () => {
  it('reads the literal comma-bearing heading instead of splitting it into two lookups', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Setup, Teardown`, suppressStat: true })
    expect(code, text).toBe(0)
    expect(
      text,
      'the comma was read as the multi-heading separator, so two unrelated sections came back instead of the one that was asked for',
    ).toBe(`# Setup, Teardown — ${mdFile}:11-13\n## Setup, Teardown\n\nthe combined body`)
  })

  it('still splits on the comma when no heading carries that literal text', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Setup,Teardown`, suppressStat: true })
    expect(code, text).toBe(0)
    expect(text, 'the multi-heading grammar stopped working for genuinely separate headings').toBe(
      `Setup:\n# Setup — ${mdFile}:3-5\n## Setup\n\nsetup only` +
        `\n\nTeardown:\n# Teardown — ${mdFile}:7-9\n## Teardown\n\nteardown only`,
    )
  })
})
