/**
 * `types` scans each kind with `TYPES_SCAN_LIMIT` (graph_commands.ts), a per-kind cap on the SQL
 * query feeding the whole command, not on the `--limit` DISPLAY window applied afterward in JS.
 * The function's own comment describes this scan as meant to be uncapped ("Every declaration that
 * survives --exclude-tests, uncapped"), and the file's own history names the exact failure this
 * kind of cap produces: `totalCount` can only report the count of what survived the SQL cutoff,
 * not what genuinely exists, and `--grep` can only ever match inside the capped window, so a
 * declaration ranked below the cap is unfindable by name no matter how high `--limit` is raised.
 * HAND-DERIVED fixture: 5,001 same-kind ('interface') symbol rows inserted directly (not parsed
 * from real files), since only the row count and file-path ordering matter here, not real syntax.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runTypes } from '../src/graph_commands.js'

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Run `fn` with `process.stdout.write` captured, returning whatever it wrote. */
function captureStdout(fn: () => void): string {
  let captured = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => { captured += String(chunk); return true }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = origWrite
  }
  return captured
}

/** Run `fn` with `process.stderr.write` captured, returning whatever it wrote. */
function captureStderr(fn: () => void): string {
  let captured = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = origWrite
  }
  return captured
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-types-scancap-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('types: the per-kind scan cap must not undercount or hide a real declaration', () => {
  it('reports the true totalCount and lets --grep find a declaration past the old 5,000-per-kind cap', () => {
    const db = getDb(globalDbPath())
    const insert = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const rootNorm = normalizePath(root)
    const insertMany = db.transaction((count: number) => {
      for (let i = 1; i <= count; i++) {
        const idx = String(i).padStart(5, '0')
        insert.run(`${rootNorm}/src/f${idx}.ts`, `I${idx}`, 'interface', 1, 1, `interface I${idx} {}`, '')
      }
    })
    insertMany(5001)

    let code = -1
    const out = captureStdout(() => { code = runTypes({ json: true, limit: 10_000 }) })
    expect(code).toBe(0)
    const payload = JSON.parse(out) as { items: unknown[]; totalCount: number }
    expect(payload.totalCount, 'the real population is 5,001; the old 5,000-per-kind scan cap reported one fewer').toBe(5001)

    let grepCode = -1
    let grepOut = ''
    const grepErr = captureStderr(() => {
      grepOut = captureStdout(() => { grepCode = runTypes({ grep: 'I05001' }) })
    })
    expect(grepCode).toBe(0)
    expect(grepOut, 'the 5001st interface, past the old scan cap, must be findable by --grep on its exact name').toContain('I05001')
    expect(grepErr, 'a row the scan never fetched must not be reported as filtered out by --grep').not.toContain('filtered out')
  })
})
