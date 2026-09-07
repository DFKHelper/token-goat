/**
 * `map`'s file count is a floor once the walk stopped at its ceiling.
 *
 * walkProject bounds itself at MAX_FILES_SCANNED (20000) and simply stops, so on a tree larger than
 * that `files.length` is exactly the ceiling and the language histogram is tallied over a partial
 * tree. formatProjectMap printed both flat -- `Files: 20000` -- which no reader can tell apart from a
 * repository that genuinely holds 20000 source files. collectWalkIndexFiles already treats the same
 * ceiling as a floor in its refusal text ("walk stopped at N; the real total is at least that"); this
 * pins the renderer to the same honesty.
 *
 * Both halves are asserted: the floor form present AND the flat form absent. A previous defect in
 * this repo printed a fabricated `lines 0-0` that a presence-only assertion sailed straight past.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatProjectMap, walkProject, MAX_FILES_SCANNED } from '../src/baseline.js'
import type { ProjectMap } from '../src/baseline.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mapfloor-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

// Provenance: HAND-DERIVED. Built here from the values the assertions read, never from
// buildProjectMap's output, so the renderer is checked against a stated input rather than against
// itself.
function mapOf(over: Partial<ProjectMap>): ProjectMap {
  return {
    rootDir: path.join(os.tmpdir(), 'someproj'),
    fileCount: 20000,
    languages: { typescript: 19000, python: 1000 },
    topSymbols: [],
    recentFiles: [],
    compact: true,
    ...over,
  }
}

describe('walkProject truncation flag', () => {
  it('reports truncated when the walk stopped at maxFiles', () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(TMP, `f${i}.ts`), 'export const x = 1\n')

    const result = walkProject(TMP, { maxFiles: 2 })

    expect(result.files.length).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('reports not-truncated when the walk ran out of tree first', () => {
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(TMP, `f${i}.ts`), 'export const x = 1\n')

    const result = walkProject(TMP, { maxFiles: 50 })

    expect(result.files.length).toBe(3)
    expect(result.truncated).toBe(false)
  })
})

describe('formatProjectMap file count honesty', () => {
  it('prints the file count and language histogram as floors when the walk was capped', () => {
    const text = formatProjectMap(mapOf({ fileCountTruncated: true }), true)
    const lines = text.split('\n')

    expect(lines).toContain(`Files: at least 20000 (walk stopped at the ${MAX_FILES_SCANNED}-file cap)`)
    // The flat form is what shipped, and it is a substring of nothing in the honest line, so an
    // exact whole-line check is what proves it is gone rather than merely reworded around.
    expect(lines).not.toContain('Files: 20000')
    expect(lines).toContain('Languages: typescript 19000, python 1000 (counted over a truncated walk; each count is a lower bound)')
    expect(lines).not.toContain('Languages: typescript 19000, python 1000')
  })

  it('prints flat counts, with no floor wording, when the walk completed', () => {
    const text = formatProjectMap(mapOf({ fileCount: 12, languages: { typescript: 12 }, fileCountTruncated: false }), true)
    const lines = text.split('\n')

    expect(lines).toContain('Files: 12')
    expect(lines).toContain('Languages: typescript 12')
    expect(text).not.toContain('at least')
    expect(text).not.toContain('lower bound')
  })
})
