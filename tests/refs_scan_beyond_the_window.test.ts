/**
 * Regression: `refs --top`, `--exclude-tests` and `--grep` narrow the resolved set in JavaScript
 * after the query returns, so the SQL cap they queried under decided which rows the filter could
 * ever see. That cap was 20,000, and queryRefs orders by `file_path, line` -- alphabetically, not
 * by count -- so the "top files by reference count" was really the top files among whichever
 * sorted first, and `--exclude-tests` selected from a prefix of the matches rather than all of
 * them.
 *
 * The cap read as generous. It was not: measured against the live index on the machine this was
 * written on, `expect` holds 143,666 references (7.2x the window), `toBe` 62,841 and `test`
 * 52,484, with four further names past it. `token-goat refs expect --top 8` reported a leading
 * file of 695 references while the real leader held 1,571 and did not appear at all; for
 * `push --exclude-tests`, 2,459 of 17,484 genuine non-test references were unreachable at any
 * --limit. See tests/symbol_scan_beyond_one_page.test.ts for the same defect in `find`/`locate`.
 *
 * HAND-DERIVED: the row counts below are computed from the retired cap's own value (20,000) --
 * one filler past it -- and from the arithmetic that makes the target outrank every filler file.
 * Nothing here is read back from this fix's output. The fillers each hold ONE reference in their
 * own file and the target holds several in one file, so ranking by count puts the target first
 * while ranking by the scanned prefix cannot reach it at all.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runRefs } from '../src/read_commands.js'

/** One past the retired 20,000-row cap, so a single capped query cannot reach the target below. */
const FILLER_ROWS = 20_001
/** More than the one reference each filler file holds, so counting ranks the target first. */
const TARGET_REFS = 4
const SYMBOL = 'quokkaFanout'

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

// Seeded once for the file, not per test: a bare-name `refs` spec is not scoped to a project root here, so a per-test re-seed would let each run count the rows the previous ones left behind and `totalCount` would climb with the test order.
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refs-window-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)

  const normalized = normalizePath(root)
  const db = getDb(globalDbPath())
  const insertRef = db.prepare('INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < FILLER_ROWS; i++) {
      // The `aaa` prefix with zero padding keeps every filler ahead of the target in the query's own file_path ordering, and `.test.ts` makes them the rows --exclude-tests must drop.
      insertRef.run(`${normalized}/aaa_filler_${String(i).padStart(6, '0')}.test.ts`, SYMBOL, 1, 0, '')
    }
    for (let line = 1; line <= TARGET_REFS; line++) {
      insertRef.run(`${normalized}/zzz_target.ts`, SYMBOL, line, 0, '')
    }
  })()
})

afterAll(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('refs filters see every matching row, not a capped prefix', () => {
  it('--top ranks by reference count across the whole project, not across the rows that sorted first', () => {
    const { stdout } = capture(() => { runRefs({ spec: SYMBOL, top: 1 }) })

    // The target is the only file holding more than one reference, so it is the top file by count regardless of where it sorts alphabetically.
    expect(stdout).toContain('zzz_target.ts')
    expect(stdout).not.toContain('aaa_filler_')
  })

  it('--exclude-tests reaches a non-test reference that sorts past the retired window', () => {
    const { stdout } = capture(() => { runRefs({ spec: SYMBOL, excludeTests: true }) })

    // Every filler is a test file, so the target is the entire non-test result set. A capped scan sees only fillers and reports the flag emptied the block.
    expect(stdout).toContain('zzz_target.ts')
  })

  it('reports the exact post-filter total rather than a floor, now that the filter saw every row', () => {
    const { stdout } = capture(() => { runRefs({ spec: SYMBOL, excludeTests: true, limit: 2, json: true }) })
    const payload = JSON.parse(stdout) as { items: unknown[]; totalCount: number }

    // --limit holds the rendered rows to 2; totalCount must still be the whole filtered set, which a capped scan could not have counted.
    expect(payload.items).toHaveLength(2)
    expect(payload.totalCount).toBe(TARGET_REFS)
  })
})
