import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProjectMap, formatProjectMap, walkProject } from '../src/baseline.js'
import { loadConfig } from '../src/config.js'

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-'))
  // Permissive default so existing tests (none of whose fixture files match isTestFile) are
  // unaffected; individual tests override as needed.
  vi.mocked(loadConfig).mockReturnValue({
    repomap: { exclude_tests: false },
  } as unknown as ReturnType<typeof loadConfig>)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const p = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

describe('buildProjectMap', () => {
  it('returns fileCount > 0 for a populated directory', () => {
    write('a.ts', 'export const x = 1\n')
    write('b.py', 'x = 1\n')
    const map = buildProjectMap(TMP)
    expect(map.fileCount).toBeGreaterThan(0)
    expect(map.rootDir).toBe(path.resolve(TMP))
  })

  it('counts languages matching the files present', () => {
    write('a.ts', 'export const x = 1\n')
    write('b.ts', 'export const y = 2\n')
    write('c.py', 'z = 3\n')
    write('readme.md', '# hi\n')
    const map = buildProjectMap(TMP)
    expect(map.languages['typescript']).toBe(2)
    expect(map.languages['python']).toBe(1)
    expect(map.languages['markdown']).toBe(1)
  })

  it('skips heavyweight directories like node_modules', () => {
    write('src.ts', 'export const x = 1\n')
    write('node_modules/pkg/index.js', 'module.exports = {}\n')
    const map = buildProjectMap(TMP)
    // Only the top-level source file is counted, not the node_modules entry.
    expect(map.fileCount).toBe(1)
    expect(map.languages['javascript']).toBeUndefined()
  })

  // Regression: repomap.exclude_tests was validated from TOML and reported by `token-goat
  // ignores`/`doctor`, but buildProjectMap (which backs `token-goat map` and `token-goat
  // baseline`) never consulted it -- test files always counted toward the project map
  // regardless of the setting.
  it('excludes test files from the project map when repomap.exclude_tests is true', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: true },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(TMP)

    expect(map.fileCount).toBe(1)
    expect(map.recentFiles.some((f) => f.includes('add.test.ts'))).toBe(false)
  })

  it('includes test files in the project map when repomap.exclude_tests is false', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: false },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(TMP)

    expect(map.fileCount).toBe(2)
  })
})

describe('walkProject', () => {
  it('excludes test files when opts.excludeTests is true', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')

    const result = walkProject(TMP, { excludeTests: true })

    expect(result.files.some((f) => f.includes('add.test.ts'))).toBe(false)
    expect(result.files.some((f) => f.endsWith('add.ts') && !f.includes('test'))).toBe(true)
  })

  it('includes test files when opts.excludeTests is false or omitted', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')

    const result = walkProject(TMP)

    expect(result.files.some((f) => f.includes('add.test.ts'))).toBe(true)
  })
})

describe('formatProjectMap', () => {
  it('compact output has fewer lines than the full form', () => {
    write('a.ts', 'export const x = 1\n')
    write('b.py', 'z = 3\n')
    const map = buildProjectMap(TMP)

    const full = formatProjectMap(map, false)
    const compact = formatProjectMap(map, true)
    expect(compact.split('\n').length).toBeLessThan(full.split('\n').length)
  })

  it('includes file count and language summary in the header', () => {
    write('a.ts', 'export const x = 1\n')
    const map = buildProjectMap(TMP)
    const text = formatProjectMap(map, false)
    expect(text).toContain(`Files: ${map.fileCount}`)
    expect(text).toContain('typescript')
  })
})
