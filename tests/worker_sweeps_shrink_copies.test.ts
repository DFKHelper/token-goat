// HAND-DERIVED: the copy names follow materializeShrunkImageFile in src/bridges/vscode_hooks.ts (token-goat-shrink-<pid>-<ms>-<uuid>.<fmt>), and the ages are set relative to the one-hour delivery window independently of the sweep's code.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { runWorkerLoop } from '../src/worker.js'
import { SHRINK_COPY_MAX_AGE_MS, sweepStaleShrinkCopies } from '../src/shrink_temp_copies.js'

const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const
const priorTemp = TEMP_KEYS.map((k) => process.env[k])
let scratch: string
let tempDir: string
let dataDir: string

function plant(name: string, ageMs: number): string {
  const file = path.join(tempDir, name)
  fs.writeFileSync(file, 'jpeg bytes')
  const at = (Date.now() - ageMs) / 1000
  fs.utimesSync(file, at, at)
  return file
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shrink-sweep-'))
  tempDir = path.join(scratch, 'temp')
  dataDir = path.join(scratch, 'data')
  fs.mkdirSync(tempDir)
  fs.mkdirSync(dataDir)
  for (const k of TEMP_KEYS) process.env[k] = tempDir
})

afterEach(() => {
  TEMP_KEYS.forEach((k, i) => {
    const v = priorTemp[i]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  // The loop opens the data dir's databases, which Windows will not let the directory be removed under.
  closeAllDbs()
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the worker sweeps stale shrunk image copies from the OS temp dir', () => {
  it('removes copies past the delivery window on its first housekeeping pass and keeps everything else', async () => {
    expect(os.tmpdir()).toBe(tempDir)
    const stale = plant('token-goat-shrink-4242-1000-aaaa.jpeg', SHRINK_COPY_MAX_AGE_MS + 60_000)
    const fresh = plant('token-goat-shrink-4242-2000-bbbb.jpeg', SHRINK_COPY_MAX_AGE_MS - 60_000)
    const foreign = plant('someone-else-1000.jpeg', 3 * SHRINK_COPY_MAX_AGE_MS)
    const dirLike = path.join(tempDir, 'token-goat-shrink-dir')
    fs.mkdirSync(dirLike)
    const at = (Date.now() - 3 * SHRINK_COPY_MAX_AGE_MS) / 1000
    fs.utimesSync(dirLike, at, at)

    let ticks = 0
    await runWorkerLoop(dataDir, 2000, () => ticks++ > 0)

    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
    expect(fs.existsSync(dirLike)).toBe(true)
  })

  it('reports how many copies it removed and survives a temp dir that cannot be listed', () => {
    plant('token-goat-shrink-1-1-a.webp', SHRINK_COPY_MAX_AGE_MS + 1_000)
    plant('token-goat-shrink-1-2-b.webp', SHRINK_COPY_MAX_AGE_MS + 1_000)
    expect(sweepStaleShrinkCopies()).toBe(2)
    expect(sweepStaleShrinkCopies()).toBe(0)
    expect(sweepStaleShrinkCopies(Date.now(), path.join(scratch, 'missing'))).toBe(0)
  })
})
