import { describe, expect, it } from 'vitest'
import { compressBashOutput, dedupeConsecutiveText } from '../src/tool_filters/helpers.js'

describe('text-based consecutive-line deduplication', () => {
  it('collapses repeated lines and preserves a trailing newline', () => {
    expect(dedupeConsecutiveText('same\nsame\nnext\n')).toBe('same  (×2)\nnext\n')
  })

  it('leaves unique and empty text unchanged', () => {
    expect(dedupeConsecutiveText('one\ntwo\n')).toBe('one\ntwo\n')
    expect(dedupeConsecutiveText('')).toBe('')
  })

  it('leaves a single line alone unless minRun explicitly includes singletons', () => {
    expect(dedupeConsecutiveText('one')).toBe('one')
    expect(dedupeConsecutiveText('one', { minRun: 1 })).toBe('one  (×1)')
  })

  it('deduplicates repeated stdout and stderr independently', () => {
    expect(compressBashOutput('out\nout', 'err\nerr')).toBe('out  (×2)\n---\nerr  (×2)')
  })
})
