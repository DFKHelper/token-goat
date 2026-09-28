/** `read "file:N" --json` resolves line N to the symbol regions around it from index rows. When the file had changed on disk and the reparse could not land, the text form said so with staleWarning's line, but the JSON form returned the regions with no sign they came from old rows. It now carries `stale: true`, the key runSymbol's JSON rows already use for the same state (and `deleted: true`, runRead's key, for a gone file, though this branch reads the file first and so answers "Could not read" for one). */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Parser from '../src/parser.js'

// A changed file's rows stay stale past the read's own self-heal only when the reparse fails (or the index is read-only). This fails the parser healStaleIndex calls, only while `heal.fail` is set, so the real catch path runs and the fixture still indexes for real.
const heal = vi.hoisted(() => ({ fail: false }))
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Parser>()
  return {
    ...actual,
    indexFileSync: (...args: Parameters<typeof actual.indexFileSync>) => {
      if (heal.fail) throw new Error('simulated reparse failure')
      return actual.indexFileSync(...args)
    },
  }
})

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRead } from '../src/read_commands.js'

let root: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-line-region-json-')))
  heal.fail = false
})

afterEach(() => {
  heal.fail = false
  rmSync(root, { recursive: true, force: true })
})

// HAND-DERIVED: one three-line function, so line 2 resolves to exactly one region.
function indexedModule(): string {
  const file = join(root, 'region_mod4r.ts')
  writeFileSync(file, 'export function regionTarget4r(): number {\n  return 1\n}\n')
  indexFileSync(normalizePath(file))
  return file
}

describe('read "file:N" --json flags rows older than the file', () => {
  it('carries stale: true when the file changed and the reparse did not land', () => {
    const file = indexedModule()
    writeFileSync(file, 'export function regionTarget4r(): number {\n  return 2\n}\n')
    heal.fail = true
    const r = runRead({ spec: `${file}:2`, json: true })
    expect(r.code).toBe(0)
    const payload = JSON.parse(r.text) as { regions: unknown[]; stale?: boolean; deleted?: boolean }
    expect(payload.regions).toHaveLength(1)
    expect(payload.stale).toBe(true)
    expect(payload).not.toHaveProperty('deleted')
    // The text form of the same read already said so; the JSON form now agrees with it.
    expect(runRead({ spec: `${file}:2` }).text).toContain('STALE')
  })

  it('adds neither key when the rows match the file', () => {
    const file = indexedModule()
    const payload = JSON.parse(runRead({ spec: `${file}:2`, json: true }).text) as Record<string, unknown>
    expect(payload).not.toHaveProperty('stale')
    expect(payload).not.toHaveProperty('deleted')
  })
})
