// A session save that cannot read the cache already on disk leaves it alone. Every hook call is its own process, and each save reads the file, merges its own view in and writes the result back. When that read answered "nothing on disk" for a file a scanner was briefly holding, the save wrote this process's view alone over it, and every file an earlier hook recorded for the session was forgotten: the read-dedup hints and the pre-compact manifest both go blank mid-session. The same read in src/project_memory.ts::loadRaw was fixed for the same reason. Provenance: HAND-DERIVED. EBUSY is the code Windows returns for a file another process holds open without sharing (libuv maps ERROR_SHARING_VIOLATION to it), forced here by a pass-through `node:fs`.
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NodeFsModule from 'node:fs'

type NodeFs = typeof NodeFsModule

const held = vi.hoisted(() => ({ file: '', reads: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFs>()
  const readFileSync = (file: Parameters<NodeFs['readFileSync']>[0], ...rest: unknown[]): unknown => {
    if (held.file !== '' && String(file) === held.file) {
      held.reads += 1
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(file)}'`), { code: 'EBUSY' })
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)
  }
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

const fs = await vi.importActual<NodeFs>('node:fs')
const { readSessionStateFile, saveSessionState } = await import('../src/session_store.js')
const { importSessionState, recordFileRead } = await import('../src/session.js')

const SESSION = 'held-cache-session'
const EMPTY = { files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sess-held-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  held.file = ''
  held.reads = 0
  importSessionState(EMPTY)
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function sessionFile(): string {
  const found = fs.readdirSync(path.join(tmpHome, 'sessions')).filter((f) => f.endsWith('.json'))
  expect(found, 'calibration: exactly one session file was written').toHaveLength(1)
  return path.join(tmpHome, 'sessions', found[0]!)
}

describe('saving a session whose cache file is held by another process', () => {
  it('keeps the files an earlier hook recorded', () => {
    // An earlier hook process records a read and saves.
    importSessionState(EMPTY)
    recordFileRead('/proj/earlier.ts')
    saveSessionState(SESSION)
    const file = sessionFile()

    // A later hook process whose own view never saw that read, saving while the file is held.
    importSessionState(EMPTY)
    recordFileRead('/proj/later.ts')
    held.file = file
    saveSessionState(SESSION)
    held.file = ''

    expect(held.reads, 'calibration: the save tried to read the held file').toBeGreaterThan(0)
    const paths = (readSessionStateFile(SESSION)?.files ?? []).map((f) => f.path)
    expect(paths.some((p) => p.endsWith('earlier.ts')), `the held cache was replaced: ${JSON.stringify(paths)}`).toBe(true)
  })
})
