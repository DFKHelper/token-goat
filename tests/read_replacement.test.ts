import { describe, expect, it } from 'vitest'

import { buildPreReadReplacement } from '../src/read_replacement.js'

describe('buildPreReadReplacement', () => {
  it('returns null for empty file path', () => {
    expect(buildPreReadReplacement(undefined)).toBeNull()
    expect(buildPreReadReplacement('')).toBeNull()
    expect(buildPreReadReplacement('   ')).toBeNull()
  })

  it('returns null for unknown file extensions', () => {
    expect(buildPreReadReplacement('file.xyz')).toBeNull()
    expect(buildPreReadReplacement('file.bin')).toBeNull()
    expect(buildPreReadReplacement('file')).toBeNull()
  })

  it('returns hint for Python files', () => {
    const result = buildPreReadReplacement('module.py')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat read')
    expect(result?.hint).toContain('function/class')
  })

  it('returns hint for TypeScript files', () => {
    const result = buildPreReadReplacement('module.ts')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat read')
  })

  it('returns hint for JavaScript files', () => {
    const result = buildPreReadReplacement('app.js')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat read')
  })

  it('returns hint for React/TSX files', () => {
    const result = buildPreReadReplacement('Component.tsx')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat')
  })

  it('returns hint for JSX files', () => {
    const result = buildPreReadReplacement('Button.jsx')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat')
  })

  it('returns hint for Markdown files', () => {
    const result = buildPreReadReplacement('README.md')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat section')
    expect(result?.hint).not.toContain('function/class')
  })

  it('returns hint for text files', () => {
    const result = buildPreReadReplacement('notes.txt')
    expect(result).not.toBeNull()
    expect(result?.hint).toContain('token-goat section')
  })

  it('includes file path in hint', () => {
    const result = buildPreReadReplacement('src/utils/helpers.py')
    expect(result?.hint).toContain('src/utils/helpers.py')
  })

  it('case-insensitively matches file extensions', () => {
    const resultUpper = buildPreReadReplacement('FILE.PY')
    const resultLower = buildPreReadReplacement('file.py')
    expect(resultUpper).not.toBeNull()
    expect(resultLower).not.toBeNull()
  })

  it('ignores sessionId parameter when building hint', () => {
    const resultWithSession = buildPreReadReplacement('test.py', 'session123')
    const resultWithoutSession = buildPreReadReplacement('test.py')
    expect(resultWithSession).toEqual(resultWithoutSession)
  })

  it('ignores opts parameter when building hint', () => {
    const result1 = buildPreReadReplacement('test.py', undefined, { maxFileBytes: 10000 })
    const result2 = buildPreReadReplacement('test.py')
    expect(result1).toEqual(result2)
  })

  it('formats hint with proper indentation and command suggestions', () => {
    const result = buildPreReadReplacement('script.py')
    expect(result?.hint).toContain('token-goat read')
    expect(result?.hint).toContain('symbol_name')
    expect(result?.hint).toContain('Heading')
  })
})
