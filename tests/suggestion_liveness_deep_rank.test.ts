// A miss's near names are checked against disk window by window: stale rows ranked past the first window must not be offered, and the live name behind them must be reached.

// HAND-DERIVED: 60 files each define a function named zqitemNN and are indexed, then every sixth one is rewritten to define a different name and the other 50 deleted, behind the index's back; one more file defines a longer, live name containing the query. Ranking sorts by length closeness to the query, so the 60 stale names fill the ranks ahead of the live one, which sits past NEAR_NAME_LIVE_CHECK (50).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { NEAR_NAME_LIVE_CHECK, nearSymbolNames } from '../src/read_suggest.js'

const STALE_COUNT = NEAR_NAME_LIVE_CHECK + 10
const LIVE_NAME = 'zqitemTheOneThatIsStillThere'

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function fn(name: string): string {
  return `export function ${name}(): number {\n  return 1\n}\n`
}

beforeEach(() => {
  root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-live-deep-')))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const stale: string[] = []
  for (let i = 0; i < STALE_COUNT; i++) {
    const file = path.join(root, 'src', `s${String(i).padStart(2, '0')}.ts`)
    fs.writeFileSync(file, fn(`zqitem${String(i).padStart(2, '0')}`))
    indexFileSync(file)
    stale.push(file)
  }
  const live = path.join(root, 'src', 'live.ts')
  fs.writeFileSync(live, fn(LIVE_NAME))
  indexFileSync(live)
  stale.forEach((file, i) => {
    if (i % 6 === 0) fs.writeFileSync(file, fn(`renamedAway${String(i).padStart(2, '0')}`))
    else fs.rmSync(file)
  })
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('near-name liveness past the first window', () => {
  it('offers only the live name when every name ranked ahead of it was renamed or deleted', () => {
    expect(nearSymbolNames('zqitem', root)).toEqual({ skipped: false, candidates: [LIVE_NAME] })
  })
})
