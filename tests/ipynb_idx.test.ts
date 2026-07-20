import { describe, it, expect } from 'vitest'

import { ipynbToVirtualSource } from '../src/languages/ipynb_idx.js'

function notebook(
  cells: unknown[],
  metadata: Record<string, unknown> = { kernelspec: { language: 'python' } },
): string {
  return JSON.stringify({ cells, metadata })
}

describe('ipynbToVirtualSource', () => {
  it('flattens code cells and a markdown cell into the virtual document, in order, as Python', () => {
    const nb = notebook([
      { cell_type: 'code', source: 'def foo():\n    return 1\n' },
      { cell_type: 'markdown', source: 'This explains bar.' },
      { cell_type: 'code', source: 'def bar():\n    return 2\n' },
    ])
    const result = ipynbToVirtualSource(nb)
    expect(result.cellLanguage).toBe('python')
    const fooIdx = result.content.indexOf('def foo')
    const mdIdx = result.content.indexOf('# This explains bar.')
    const barIdx = result.content.indexOf('def bar')
    expect(fooIdx).toBeGreaterThanOrEqual(0)
    expect(mdIdx).toBeGreaterThan(fooIdx)
    expect(barIdx).toBeGreaterThan(mdIdx)
    expect(result.content).toContain('# %% cell 0')
    expect(result.content).toContain('# %% [markdown] cell 1')
    expect(result.content).toContain('# %% cell 2')
  })

  it('normalizes source given as an array of per-line strings (each ending in \\n)', () => {
    const nb = notebook([{ cell_type: 'code', source: ['import foo\n', 'def bar():\n', '    return 1\n'] }])
    const result = ipynbToVirtualSource(nb)
    expect(result.content).toContain('import foo\ndef bar():\n    return 1')
  })

  it('normalizes source given as a single string identically to the array form', () => {
    const nbArray = notebook([{ cell_type: 'code', source: ['import foo\n', 'def bar():\n', '    return 1\n'] }])
    const nbString = notebook([{ cell_type: 'code', source: 'import foo\ndef bar():\n    return 1\n' }])
    expect(ipynbToVirtualSource(nbArray).content).toBe(ipynbToVirtualSource(nbString).content)
  })

  it('normalizes source given as an array whose elements do NOT end in \\n by joining with \\n', () => {
    const nb = notebook([{ cell_type: 'code', source: ['import foo', 'def bar():', '    return 1'] }])
    const result = ipynbToVirtualSource(nb)
    expect(result.content).toContain('import foo\ndef bar():\n    return 1')
  })

  it('returns an empty, non-throwing result for malformed/non-JSON input', () => {
    expect(ipynbToVirtualSource('not json{{{')).toEqual({ content: '', cellLanguage: null })
    expect(ipynbToVirtualSource('[]')).toEqual({ content: '', cellLanguage: null })
    expect(ipynbToVirtualSource('{"cells": "nope"}')).toEqual({ content: '', cellLanguage: null })
  })

  it('treats an explicit non-Python kernelspec.language as unsupported', () => {
    const nb = notebook([{ cell_type: 'code', source: 'f <- function() 1\n' }], {
      kernelspec: { language: 'r' },
    })
    const result = ipynbToVirtualSource(nb)
    expect(result).toEqual({ content: '', cellLanguage: null })
  })

  it('defaults to Python when kernelspec/language_info metadata is entirely missing', () => {
    const nb = JSON.stringify({ cells: [{ cell_type: 'code', source: 'def foo():\n    return 1\n' }] })
    const result = ipynbToVirtualSource(nb)
    expect(result.cellLanguage).toBe('python')
    expect(result.content).toContain('def foo')
  })

  it('skips raw cells entirely', () => {
    const nb = notebook([
      { cell_type: 'raw', source: 'this is raw text, kernel-specific' },
      { cell_type: 'code', source: 'def foo():\n    return 1\n' },
    ])
    const result = ipynbToVirtualSource(nb)
    expect(result.content).not.toContain('raw text')
    expect(result.content).toContain('# %% cell 1')
  })
})
