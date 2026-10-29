/** `map`'s file count is a floor once the walk stopped at its file or entry ceiling. walkProject bounds source files at MAX_FILES_SCANNED (20000) and directory entries separately; either ceiling can stop the walk before all source files are found, and the language histogram is tallied over the same partial tree. formatProjectMap previously printed both flat -- `Files: 20000` -- which no reader can tell apart from a repository that genuinely holds 20000 source files. collectWalkIndexFiles now refuses an incomplete walk; this pins the renderer to the same honesty. Both halves are asserted: the floor form present AND the flat form absent. A previous defect in this repo printed a fabricated `lines 0-0` that a presence-only assertion sailed straight past. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ts from 'typescript'

import { formatProjectMap, walkProject, MAX_FILES_SCANNED } from '../src/baseline.js'
import type { ProjectMap } from '../src/baseline.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mapfloor-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

// Provenance: HAND-DERIVED. Built here from the values the assertions read, never from buildProjectMap's output, so the renderer is checked against a stated input rather than against itself.
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

  it('bounds directory entries even when the tree contains no recognized source files', () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(TMP, `f${i}.opaque`), 'data\n')

    const result = walkProject(TMP, { maxFiles: 2, maxEntries: 4 })

    expect(result.files).toHaveLength(0)
    expect(result.truncated, 'the entry ceiling must mark an incomplete walk').toBe(true)
  })

  it('streams directory entries instead of materializing a complete listing', () => {
    const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/baseline.ts')
    const source = fs.readFileSync(sourcePath, 'utf8')
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const walker = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'walkProject',
    )
    if (!walker?.body) throw new Error('walkProject function body was not found')

    const directoryReadCalls: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'fs'
      ) {
        directoryReadCalls.push(node.expression.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(walker.body)

    expect(directoryReadCalls, 'walkProject must incrementally open directories').toContain('opendirSync')
    expect(directoryReadCalls, 'walkProject must not materialize directory listings').not.toContain('readdirSync')
  })
})

describe('formatProjectMap file count honesty', () => {
  it('prints the file count and language histogram as floors when the walk was capped', () => {
    const text = formatProjectMap(mapOf({ fileCountTruncated: true }), true)
    const lines = text.split('\n')

    expect(lines).toContain(`Files: at least 20000 (walk stopped at the ${MAX_FILES_SCANNED}-file cap)`)
    // The flat form is what shipped, and it is a substring of nothing in the honest line, so an exact whole-line check is what proves it is gone rather than merely reworded around.
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

  it('identifies directory-entry truncation without claiming the file-count cap', () => {
    const lines = formatProjectMap(mapOf({ fileCount: 7, fileCountTruncated: true }), true).split('\n')

    expect(lines).toContain('Files: at least 7 (walk stopped at the directory-entry safety cap)')
    expect(lines).not.toContain(`Files: at least 7 (walk stopped at the ${MAX_FILES_SCANNED}-file cap)`)
  })
})
