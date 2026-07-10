/**
 * Regression: `global.db` is a single machine-wide index keyed by absolute path across every
 * project ever indexed (see constants.ts). `runFind` (src/read_commands.ts) used to call
 * `querySymbols({ limit: FIND_SCAN_LIMIT })` with no project scope, so `token-goat find` emitted
 * matching file paths from every project ever indexed on the machine, not just the current one.
 *
 * Unlike tests/read_commands.test.ts (which mocks index_reader.js entirely), this test exercises
 * the real querySymbols/getDb path against a real (test-isolated) global.db, mirroring
 * tests/baseline.test.ts's cross-project-scoping regression pattern for `map`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { runFind } from '../src/read_commands.js'

/** Capture stdout for a function call. */
function capture(fn: () => void): string {
  let stdout = ''
  const origOut = process.stdout.write.bind(process.stdout)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => {
    stdout += s
    return true
  }
  try {
    fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = origOut
  }
  return stdout
}

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-find-rootA-'))
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-find-rootB-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(rootA, { recursive: true, force: true })
  fs.rmSync(rootB, { recursive: true, force: true })
})

describe('runFind cross-project scoping', () => {
  it('never surfaces a file path from a different project root', () => {
    const rootAFile = path.join(rootA, 'sharedName.ts').replace(/\\/g, '/')
    const rootBFile = path.join(rootB, 'sharedName.ts').replace(/\\/g, '/')

    const db = getDb(globalDbPath())
    const insert = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(rootAFile, 'sharedNameHelper', 'function', 1, 1, '', '')
    insert.run(rootBFile, 'sharedNameHelper', 'function', 1, 1, '', '')

    const stdout = capture(() => {
      runFind({ pattern: 'sharedName' })
    })

    expect(stdout).toContain(path.basename(rootA))
    expect(stdout).not.toContain(path.basename(rootB))
  })
})
