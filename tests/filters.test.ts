import { describe, expect, it } from 'vitest'

import { FILTERS } from '../src/filters.js'
import type { Filter } from '../src/filters.js'

/** Run the first matching filter over a line, mirroring compressOutput. */
function applyFirst(line: string): { matched: Filter | null; result: string | null } {
  for (const filter of FILTERS) {
    if (filter.pattern === null || filter.pattern.test(line)) {
      return { matched: filter, result: filter.replacer(line) }
    }
  }
  return { matched: null, result: line }
}

describe('FILTERS', () => {
  it('is a non-empty array', () => {
    expect(FILTERS.length).toBeGreaterThan(0)
  })

  it('every filter has a name string and a replacer function', () => {
    for (const f of FILTERS) {
      expect(typeof f.name).toBe('string')
      expect(f.name.length).toBeGreaterThan(0)
      expect(typeof f.replacer).toBe('function')
      expect(f.pattern === null || f.pattern instanceof RegExp).toBe(true)
    }
  })

  it('filter names are unique', () => {
    const names = FILTERS.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('matches git progress lines and drops them', () => {
    const { matched, result } = applyFirst('remote: Counting objects: 100% (11/11), done.')
    expect(matched?.name).toBe('git-progress')
    expect(result).toBeNull()
  })

  it('matches npm install summary lines and drops them', () => {
    const { matched, result } = applyFirst('added 142 packages in 3s')
    expect(matched?.name).toBe('npm-summary')
    expect(result).toBeNull()
  })

  it('matches pip download lines and drops them', () => {
    const { result } = applyFirst('Downloading foo-1.2.3-py3-none-any.whl (1.2 MB)')
    expect(result).toBeNull()
  })

  it('matches docker pull progress and drops it', () => {
    const { matched, result } = applyFirst('abc123def456: Pull complete')
    expect(matched?.name).toBe('docker-pull')
    expect(result).toBeNull()
  })

  it('replaces a NUL-bearing binary line with a marker', () => {
    const { matched, result } = applyFirst('text\x00more')
    expect(matched?.name).toBe('binary-content')
    expect(result).toBe('[binary content elided by token-goat]')
  })

  it('does not match normal output lines', () => {
    const normal = [
      'Compilation finished successfully.',
      'Tests: 5 passed, 0 failed',
      'The build percentage report says 50% of features are done.',
      'def my_function():',
      'export const x = 1',
    ]
    for (const line of normal) {
      const { matched } = applyFirst(line)
      expect(matched).toBeNull()
    }
  })
})
