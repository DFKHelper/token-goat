/** Past SUGGEST_NAME_BUDGET distinct names a `symbol` miss skips near-name ranking, and it has to say so: a miss with no "Did you mean" otherwise reads as "nothing indexed is close", and ranking only the names read before the budget ran out would present an arbitrary subset as the project-wide nearest. The real budget (500,000 names) is far past anything a test can seed, so the exported constant is lowered to 3 here; read_suggest.ts reads it from the module and passes it to projectSymbolNames, so the lowered value reaches the same query the shipping path runs. Fixture provenance: HAND-DERIVED. Four seeded names against a budget of three; the expected note is the sentence nearNamesSkippedNote builds from that budget, and the typo control is one edit from a seeded name. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SymbolScan from '../src/symbol_scan.js'

vi.mock('../src/symbol_scan.js', async (importOriginal) => ({ ...(await importOriginal<typeof SymbolScan>()), SUGGEST_NAME_BUDGET: 3 }))

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_symbol.js'
import { projectSymbolNames } from '../src/symbol_scan.js'

let root: string

function seed(names: string[]): void {
  const db = getDb(globalDbPath())
  const insert = db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
  db.transaction(() => {
    names.forEach((name, i) => insert.run(`${root}/f${i}.ts`, name, 'function', 1, 1, '', ''))
  })()
}

beforeEach(() => {
  root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-miss-note-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('symbol miss past the near-name budget', () => {
  it('says the suggestions were skipped instead of ranking a subset', () => {
    seed(['wombatAlpha', 'wombatBravo', 'wombatCharlie', 'wombatDelta'])
    const { text, code } = runSymbol({ name: 'wombatDeltx', projectRoot: root })
    expect(code).toBe(1)
    expect(text).toBe(
      `No matches for 'wombatDeltx'\nNear-name suggestions skipped: this project indexes more than 3 distinct symbol names, too many to rank on a miss.\nTry: token-goat semantic "wombatDeltx"`,
    )
  })

  it('still ranks when the project is at the budget, not past it', () => {
    seed(['wombatAlpha', 'wombatBravo', 'wombatDelta'])
    const { text } = runSymbol({ name: 'wombatDeltx', projectRoot: root })
    expect(text).toBe(`No matches for 'wombatDeltx'\nDid you mean:\n  - wombatDelta`)
  })

  it('counts distinct names, not rows', () => {
    seed(['wombatAlpha', 'wombatAlpha', 'wombatAlpha', 'wombatAlpha', 'wombatDelta'])
    expect(projectSymbolNames(root, 3)?.sort()).toEqual(['wombatAlpha', 'wombatDelta'])
    expect(projectSymbolNames(root, 1)).toBeNull()
  })
})
