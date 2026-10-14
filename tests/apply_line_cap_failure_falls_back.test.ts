/** apply()'s per-line cap (step 7.5) ran outside the try that guards the filter, so anything it threw left apply() altogether: `token-goat compress` exited 1 and printed nothing of a command that had already run. A deeply nested one-line JSON document once did exactly that through the JSON layout, by stack overflow. The cap now sits inside the try, so a failure there falls back to the truncated view the way a filter that raises does. HAND-DERIVED: the cap is made to throw the error the overflow raised. */
import { describe, expect, it, vi } from 'vitest'

import type * as Helpers from '../src/tool_filters/helpers.js'

vi.mock('../src/tool_filters/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Helpers>()
  return {
    ...actual,
    capLongLines: vi.fn(() => {
      throw new RangeError('Maximum call stack size exceeded')
    }),
  }
})

const { GenericFilter } = await import('../src/tool_filters/generic.js')

describe('a per-line cap that throws inside apply()', () => {
  it('falls back to the truncated output instead of throwing', () => {
    const output = Array.from({ length: 50 }, (_, i) => `built module ${i}`).join('\n')
    const result = new GenericFilter().apply(output, '', 0, [])
    expect(result.notes).toContain('generic filter raised RangeError; truncated raw')
    expect(result.text).toContain('built module 49')
  })
})
