// Regression: --grep and --section ran over the raw cached output, so a pattern spanning a colour boundary missed text the printed output visibly contained.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _applyFiltersAndPrint } from '../src/cli_cached_output.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let spy: WriteSpy

beforeEach(() => {
  spy = spyOnWrite(process.stdout, [])
})

afterEach(() => {
  spy.mockRestore()
})

// Provenance: CAPTURE `node node_modules/typescript/bin/tsc --noEmit --pretty -p .` (TypeScript 6.0.3, stdout piped, colour still emitted) over a file with two `const vN: string = N` lines; first error stanza, verbatim.
const TSC_PRETTY = [
  '\u001b[96msrc/c.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m14\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType \'number\' is not assignable to type \'string\'.',
  '',
  '\u001b[7m1\u001b[0m export const v1: string = 1',
  '\u001b[7m \u001b[0m \u001b[91m             ~~\u001b[0m',
  '',
  'Found 1 error in src/c.ts\u001b[90m:1\u001b[0m',
  '',
].join('\r\n')

describe('cached output is filtered as the plain text the reader sees', () => {
  it('--grep matches a pattern that spans a colour boundary', () => {
    // "error" and "TS2322" sit in different colour spans, so the raw line has escapes between them.
    const printed = _applyFiltersAndPrint(TSC_PRETTY, { grep: 'error TS2322' }, true)
    expect(printed).toContain("src/c.ts:1:14 - error TS2322: Type 'number' is not assignable to type 'string'.")
    expect(printed).not.toContain('\u001b')
  })

  it('--grep still matches a single span, and keeps the summary line (must-not-drop)', () => {
    expect(_applyFiltersAndPrint(TSC_PRETTY, { grep: 'TS2322' }, true)).toContain('TS2322')
    expect(_applyFiltersAndPrint(TSC_PRETTY, { grep: 'Found 1 error in src/c.ts:1' }, true)).toContain('Found 1 error in src/c.ts:1')
  })

  it('--section finds a heading wrapped in colour codes', () => {
    // Provenance: HAND-DERIVED a bold-wrapped markdown heading, as a coloured renderer prints it.
    const text = ['\u001b[1m## Build\u001b[0m', 'compiled ok', '## Test', 'ran 3'].join('\n')
    const printed = _applyFiltersAndPrint(text, { section: 'Build' }, true)
    expect(printed).toContain('compiled ok')
    expect(printed).not.toContain('ran 3')
  })
})
