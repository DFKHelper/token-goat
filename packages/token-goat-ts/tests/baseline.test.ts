import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildProjectMap, formatProjectMap } from '../src/baseline.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-'))
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
