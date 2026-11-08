import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ConstantsModule from '../src/constants.js'
import type * as IndexReaderModule from '../src/index_reader.js'

const dbPathState = vi.hoisted(() => ({ value: '' }))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, globalDbPath: () => dbPathState.value }
})

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return { ...actual, querySymbols: vi.fn(actual.querySymbols) }
})

import { closeDb, getDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { captureStdout } from './helpers/capture-stdout.js'
import { runCallChain } from '../src/graph_commands.js'
import { resolveCallers } from '../src/graph_traversal.js'

let fixtureRoot: string | undefined
let dbPath: string | undefined

afterEach(() => {
  if (dbPath !== undefined) closeDb(dbPath)
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true })
  dbPathState.value = ''
  fixtureRoot = undefined
  dbPath = undefined
})

function createFixtureRoot(): { root: string; dbPath: string } {
  const scratchRoot = join(process.cwd(), '.scratch')
  mkdirSync(scratchRoot, { recursive: true })
  fixtureRoot = mkdtempSync(join(scratchRoot, 'call-graph-fast-matrix-'))
  dbPath = join(fixtureRoot, 'index.db')
  dbPathState.value = dbPath
  return { root: fixtureRoot, dbPath }
}

describe('SQLite call-graph fast matrix', () => {
  it('keeps same-line callers distinct and returns a deterministic graph without source files', () => {
    const { root, dbPath: fixtureDbPath } = createFixtureRoot()
    const file = join(root, 'calls.ts')
    writeFileSync(
      file,
      [
        'export function target() {}',
        'export function alpha() { target() } export function beta() { target() }',
      ].join('\n'),
    )
    indexFileSync(file, fixtureDbPath)
    rmSync(file)

    expect(resolveCallers('target', 10, undefined, root)).toEqual([
      { caller: 'alpha', kind: 'function', file: normalizePath(file), line: 2 },
      { caller: 'beta', kind: 'function', file: normalizePath(file), line: 2 },
    ])
  })

  it('uses indexed lookups in both caller and callee directions', () => {
    const { root, dbPath: fixtureDbPath } = createFixtureRoot()
    const file = join(root, 'calls.ts')
    writeFileSync(file, 'export function alpha() { target() }\n')
    indexFileSync(file, fixtureDbPath)

    const db = getDb(fixtureDbPath)
    const calleePlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT file_path, name, line, col, context
      FROM refs
      WHERE name = ?
      ORDER BY file_path, line, col, context, id
      LIMIT ?
    `).all('target', 10) as Array<{ detail: string }>
    expect(calleePlan.some((row) => row.detail.includes('idx_refs_call_graph_callee'))).toBe(true)
    expect(calleePlan.some((row) => /SCAN refs/i.test(row.detail))).toBe(false)

    const callerPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT file_path, name, line, col, context
      FROM refs
      WHERE context = ? AND TG_LOWER(file_path) = ?
      ORDER BY line
      LIMIT 20
    `).all('alpha', normalizePath(file)) as Array<{ detail: string }>
    expect(callerPlan.some((row) => row.detail.includes('idx_refs_call_graph_caller'))).toBe(true)
    expect(callerPlan.some((row) => /SCAN refs/i.test(row.detail))).toBe(false)
  })

  it('traverses a call chain without per-file symbol lookups', () => {
    const { root, dbPath: fixtureDbPath } = createFixtureRoot()
    const file = join(root, 'calls.ts')
    writeFileSync(
      file,
      [
        'export function target() {}',
        'export function alpha() { target() } export function beta() { target() }',
      ].join('\n'),
    )
    indexFileSync(file, fixtureDbPath)
    rmSync(file)
    vi.mocked(querySymbols).mockClear()

    const output = captureStdout(() => {
      expect(runCallChain({ symbol: 'target', depth: 1, json: true })).toBe(0)
    })

    expect(JSON.parse(output)).toEqual({ chains: [['target', 'alpha'], ['target', 'beta']] })
    expect(vi.mocked(querySymbols).mock.calls.filter(([opts]) => opts?.filePath !== undefined)).toHaveLength(0)
  })
})
