import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { sessionsDir } from '../src/sessions_dir.js'
import { SHRINK_COPY_MAX_AGE_MS } from '../src/shrink_temp_copies.js'
import {
  FOREGROUND_ACTIVITY_YIELD_MS,
  hasRecentForegroundActivity,
  runWorkerLoop,
} from '../src/worker.js'

const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const
const priorTemp = TEMP_KEYS.map((k) => process.env[k])
let scratch: string
let tempDir: string
let dataDir: string

function plantStaleShrinkCopy(name: string): string {
  const file = path.join(tempDir, name)
  fs.writeFileSync(file, 'jpeg bytes')
  const at = (Date.now() - (SHRINK_COPY_MAX_AGE_MS + 60_000)) / 1000
  fs.utimesSync(file, at, at)
  return file
}

beforeEach(() => {
  clearModuleCaches()
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fg-yield-'))
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
  closeAllDbs()
  fs.rmSync(scratch, { recursive: true, force: true })
})

function touchSessionActivity(ageMs = 0): void {
  const dir = sessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, 'active.tmp')
  fs.writeFileSync(probe, '1')
  fs.unlinkSync(probe)
  const at = (Date.now() - ageMs) / 1000
  fs.utimesSync(dir, at, at)
}

describe('foreground hook activity yield gate', () => {
  it('detects recent session directory updates and expires after FOREGROUND_ACTIVITY_YIELD_MS', () => {
    expect(hasRecentForegroundActivity()).toBe(false)
    touchSessionActivity(0)
    expect(hasRecentForegroundActivity()).toBe(true)

    touchSessionActivity(FOREGROUND_ACTIVITY_YIELD_MS + 2_000)
    expect(hasRecentForegroundActivity()).toBe(false)
  })

  it('defers background housekeeping while foreground hook activity is fresh and runs it once expired', async () => {
    const stale = plantStaleShrinkCopy('token-goat-shrink-9999-1000-cccc.jpeg')
    touchSessionActivity(0)

    let ticks = 0
    await runWorkerLoop(dataDir, 2000, () => ticks++ > 0)
    // While foreground activity is fresh, housekeeping is deferred.
    expect(fs.existsSync(stale)).toBe(true)

    // Once the activity window expires, the next worker cycle runs housekeeping.
    touchSessionActivity(FOREGROUND_ACTIVITY_YIELD_MS + 2_000)

    ticks = 0
    await runWorkerLoop(dataDir, 2000, () => ticks++ > 0)
    expect(fs.existsSync(stale)).toBe(false)
  })
})
