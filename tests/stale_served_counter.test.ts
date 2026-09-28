/** Every read command that answers from index rows whose file changed on disk or is gone books one `stale_served:stale` or `stale_served:deleted` event in the stats ledger, with the command's name as the row's detail, and `token-goat stats` reports the total. The commands already warned in their output, but nothing counted it, so how often the index serves an old answer was invisible outside the one reply that carried the warning. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runBriefCore } from '../src/read_brief.js'
import { runRead } from '../src/read_commands.js'
import { runOutline, runSkeleton } from '../src/read_outline.js'
import { runRefs } from '../src/read_refs.js'
import { runSymbol } from '../src/read_symbol.js'
import { getGlobalDb } from '../src/stats.js'
import { renderShortStats } from '../src/stats_report.js'

let root: string
let origCwd: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-stale-served-')))
  origCwd = process.cwd()
  process.chdir(root)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Every `stale_served:*` row this test run has written so far, oldest first, as `kind detail` pairs. Read straight from the ledger so the assertion sees what `stats` would sum, not a spy on the producer. */
function staleRows(): string[] {
  const rows = getGlobalDb().prepare(`SELECT kind, detail FROM stats WHERE kind LIKE 'stale_served:%' ORDER BY rowid`).all() as Array<{ kind: string; detail: string | null }>
  return rows.map((r) => `${r.kind} ${r.detail ?? ''}`)
}

function newRows(before: number): string[] {
  return staleRows().slice(before)
}

// HAND-DERIVED: a one-function TypeScript module whose name is unique to this file, so a bare `symbol` lookup cannot match a row from another test.
function indexedModule(name: string, fn: string): string {
  const file = join(root, name)
  writeFileSync(file, `export function ${fn}(): number {\n  return 1\n}\n`)
  indexFileSync(normalizePath(file))
  return file
}

describe('stale_served counter', () => {
  it('read, outline, skeleton and bare symbol each book one deleted event for a gone file', () => {
    const file = indexedModule('gone_mod7q.ts', 'staleServedGone7q')
    rmSync(file)
    const before = staleRows().length

    expect(runRead({ spec: `${file}::staleServedGone7q` }).text).toContain('DELETED')
    expect(runOutline({ file }).text).toContain('DELETED')
    expect(runSkeleton({ file }).text).toContain('DELETED')
    expect(runSymbol({ name: 'staleServedGone7q', projectRoot: root }).text).toContain('DELETED')

    expect(newRows(before)).toEqual([
      'stale_served:deleted read',
      'stale_served:deleted outline',
      'stale_served:deleted skeleton',
      'stale_served:deleted symbol',
    ])
  })

  it('the --json forms of read, outline, skeleton, brief and symbol --file book the same deleted event', () => {
    const file = indexedModule('gone_json7q.ts', 'staleServedJson7q')
    rmSync(file)
    const before = staleRows().length

    expect(runRead({ spec: `${file}::staleServedJson7q`, json: true }).text).toContain('"deleted": true')
    expect(runOutline({ file, json: true }).text).toContain('"deleted": true')
    expect(runSkeleton({ file, json: true }).text).toContain('"deleted": true')
    expect(runBriefCore({ spec: `${file}::staleServedJson7q`, json: true }).text).toContain('"deleted": true')
    expect(runSymbol({ name: 'staleServedJson7q', file, json: true }).text).toContain('"deleted": true')

    expect(newRows(before)).toEqual([
      'stale_served:deleted read',
      'stale_served:deleted outline',
      'stale_served:deleted skeleton',
      'stale_served:deleted brief',
      'stale_served:deleted symbol',
    ])
  })

  it('refs books one stale event for a caller that changed on disk, and one per answer rather than per file', () => {
    const def = indexedModule('refdef_7q.ts', 'staleServedTarget7q')
    const callerA = join(root, 'refcaller_a7q.ts')
    const callerB = join(root, 'refcaller_b7q.ts')
    for (const c of [callerA, callerB]) {
      writeFileSync(c, "import { staleServedTarget7q } from './refdef_7q.js'\nstaleServedTarget7q()\n")
      indexFileSync(normalizePath(c))
      writeFileSync(c, "import { staleServedTarget7q } from './refdef_7q.js'\n// touched\nstaleServedTarget7q()\n")
    }
    const before = staleRows().length

    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(runRefs({ spec: `${def}::staleServedTarget7q` })).toBe(0)
    } finally {
      out.mockRestore()
    }

    expect(newRows(before)).toEqual(['stale_served:stale refs'])
  })

  it('books nothing when the file on disk still matches its index rows', () => {
    const file = indexedModule('fresh_mod7q.ts', 'staleServedFresh7q')
    const before = staleRows().length

    expect(runRead({ spec: `${file}::staleServedFresh7q` }).code).toBe(0)
    expect(runOutline({ file }).code).toBe(0)
    expect(runSymbol({ name: 'staleServedFresh7q', projectRoot: root }).code).toBe(0)

    expect(newRows(before)).toEqual([])
  })

  it('token-goat stats prints the stale-answer total with its changed/deleted split', () => {
    const file = indexedModule('stats_mod7q.ts', 'staleServedStats7q')
    rmSync(file)
    runRead({ spec: `${file}::staleServedStats7q` })
    const rows = staleRows()
    const deleted = rows.filter((r) => r.startsWith('stale_served:deleted')).length
    const stale = rows.length - deleted

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const savedNoColor = process.env['NO_COLOR']
    process.env['NO_COLOR'] = '1'
    try {
      renderShortStats({ windowDays: 30 })
    } finally {
      if (savedNoColor === undefined) delete process.env['NO_COLOR']
      else process.env['NO_COLOR'] = savedNoColor
    }
    const printed = log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain(`Stale answers:  ${rows.length} (${stale} changed on disk, ${deleted} deleted)`)
  })
})
