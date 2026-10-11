import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { getFileEntry, querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce } from '../src/worker.js'

const cfg = vi.hoisted(() => ({ file: '' }))

// loadConfig is deliberately NOT mocked: every other worker drain test that sets blocked_roots hands processDirtyBatch a mocked loadConfig(), so the path config.toml -> loadConfig -> processDirtyBatch is only reached here. Only the file location is redirected, to a temp file this test owns.
vi.mock('../src/constants.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), configPath: () => cfg.file }))

let DIR: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function source(name: string): string {
  return `export function ${name}(): number {\n  return 1\n}\n`
}

function enqueue(...files: string[]): void {
  fs.mkdirSync(path.join(DIR, 'queue'), { recursive: true })
  fs.writeFileSync(path.join(DIR, 'queue', 'dirty.txt'), files.map((f) => `${f}\n`).join(''))
}

// Provenance: FORMAT-DERIVED from src/config.ts (_buildConfig reads `[worker] blocked_roots` as a string list via section(raw, 'worker') and validatedStrList) and from `token-goat project exclude`, which persists the same key; the list holds an absolute directory, written with forward slashes through normalizePath so the TOML string needs no escaping.
function writeBlockedRoots(roots: string[]): void {
  fs.writeFileSync(cfg.file, `[worker]\nblocked_roots = [${roots.map((r) => JSON.stringify(normalizePath(r))).join(', ')}]\n`)
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-blocked-real-'))
  cfg.file = path.join(DIR, 'config.toml')
  // Where the daemon runs: runDetachedWorkerDaemon chdirs to os.tmpdir() before its first drain, so no project file of this repository layers over config.toml.
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir())
})

afterEach(() => {
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('the worker drain honours worker.blocked_roots from a real config.toml', () => {
  it('indexes a file outside the blocked root and neither indexes nor tracks one under it', () => {
    const blockedFile = path.join(DIR, 'vendor', 'lib.ts')
    const openFile = path.join(DIR, 'src', 'open.ts')
    fs.mkdirSync(path.dirname(blockedFile), { recursive: true })
    fs.mkdirSync(path.dirname(openFile), { recursive: true })
    fs.writeFileSync(blockedFile, source('blockedRealConfigSymbol'))
    fs.writeFileSync(openFile, source('openRealConfigSymbol'))
    const db = path.join(DIR, 'global.db')

    writeBlockedRoots([path.join(DIR, 'vendor')])
    enqueue(normalizePath(blockedFile), normalizePath(openFile))
    drainOnce(DIR)

    expect(querySymbols({ name: 'openRealConfigSymbol', limit: 10 }, db).length).toBe(1)
    expect(querySymbols({ name: 'blockedRealConfigSymbol', limit: 10 }, db).length).toBe(0)
    expect(getFileEntry(normalizePath(blockedFile), db)).toBeNull()

    // Control: with the root unblocked, the same file through the same drain does index, so the empty result above is the block and not a fixture that cannot be indexed.
    writeBlockedRoots([])
    enqueue(normalizePath(blockedFile))
    drainOnce(DIR)
    expect(querySymbols({ name: 'blockedRealConfigSymbol', limit: 10 }, db).length).toBe(1)
  })
})
