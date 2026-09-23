/**
 * Regression: `find` and `locate` match symbol names with a JavaScript substring test, but used to
 * fetch their candidate rows as a single `querySymbols({ limit: FIND_SCAN_LIMIT })` page -- a cap
 * applied by SQLite, ahead of the predicate. A symbol that sorted past that cap was therefore
 * invisible to both commands, and because both fall back to near-name ranking when nothing
 * matched, the miss did not surface as "not found": it surfaced as a confident list of unrelated
 * files for a symbol that is in the index.
 *
 * The cap was 20,000 and read as "effectively unbounded". It is not: measured against the real
 * machine-wide index this was found on, three indexed projects exceeded it and one held 234,675
 * symbols, so `find` answered from the alphabetically first 8.5% of that project. `forEachSymbol`
 * (src/symbol_scan.ts) now pages the whole scope instead.
 *
 * Fixture provenance: HAND-DERIVED. Rows are written straight into the `symbols` table with the
 * same INSERT tests/find_project_scope.test.ts uses, and the filler file names are chosen to sort
 * ahead of the target under querySymbols's own `ORDER BY file_path, line_start, rowid` -- that
 * ordering is read from the query in src/index_reader.ts, and it is the only property of the
 * production code this fixture depends on. The count is deliberately above the retired 20,000 cap
 * as well as above the paging page size, so the test fails against the shipped code it replaces
 * and against any future regression that stops after one page.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runFind } from '../src/read_commands.js'
import { runLocate } from '../src/read_inspect.js'

/** Above the retired 20,000-row cap, so a single-page scan cannot reach the target below. */
const FILLER_ROWS = 20_001

function capture(fn: () => void): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  try {
    fn()
  } finally {
    ;(process.stdout as any).write = origOut
    ;(process.stderr as any).write = origErr
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { stdout, stderr }
}

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scan-page-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)

  const normalized = normalizePath(root)
  const db = getDb(globalDbPath())
  const insert = db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (let i = 0; i < FILLER_ROWS; i++) {
      // `aaa` prefix and zero padding keep every filler ahead of the target in the query's own file_path ordering.
      insert.run(`${normalized}/aaa_filler_${String(i).padStart(6, '0')}.ts`, `fillerSymbol${i}`, 'function', 1, 1, '', '')
    }
    insert.run(`${normalized}/zzz_target.ts`, 'quokkaLandmark', 'function', 1, 1, '', '')
  })()
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('symbol name matching past the first scan page', () => {
  it('find reports the file holding a symbol that sorts beyond one page', () => {
    const { stdout, stderr } = capture(() => { runFind({ pattern: 'quokkaLandmark' }) })
    expect(stdout).toContain('zzz_target.ts')
    // The near-name fallback is what made the old miss look like an answer: it must not have run at all here.
    expect(stderr).not.toContain('nearest indexed')
  })

  it('locate reports the span of a symbol that sorts beyond one page', () => {
    const { stdout, stderr } = capture(() => { runLocate({ spec: 'quokkaLandmark' }) })
    expect(stdout).toContain('zzz_target.ts')
    expect(stdout).toContain('quokkaLandmark')
    expect(stderr).not.toContain('nearest matches')
  })

  it('counts every match in the project, not the rows it held to display them', () => {
    const { stdout } = capture(() => { runLocate({ spec: 'fillerSymbol', limit: 3, json: true }) })
    const payload = JSON.parse(stdout) as { items: unknown[]; totalCount: number; truncated: boolean }
    expect(payload.items).toHaveLength(3)
    expect(payload.totalCount).toBe(FILLER_ROWS)
    expect(payload.truncated).toBe(true)
  })
})
