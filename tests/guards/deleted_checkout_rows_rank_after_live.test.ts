/** Guard: rows left in the index by a deleted checkout (a removed `git worktree`, a sibling clone) must never outrank or pass for the live project's own rows. The worker keeps an unreachable root's rows for KNOWN_ROOT_MISSING_GRACE_MS (a sleeping external disk looks the same as a deleted directory), so for up to a week `symbol NAME` answered with the dead checkout first -- `proj-wt/` sorts ahead of `proj/` because `-` precedes `/` -- and `refs --callers` listed its call sites with no marker at all, while stderr claimed the files had merely "changed on disk" and that a repeat would show the current version. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, globalDbPath } from '../../src/constants.js'
import { closeAllDbs } from '../../src/db.js'
import { recordIndexedRoot } from '../../src/indexed_roots.js'
import { indexFileSync } from '../../src/parser.js'
const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const DELETED_MARKER = '⚠ DELETED'

let base: string
let liveDir: string
let homeDir: string

function run(args: string[], cwd = liveDir): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, USERPROFILE: homeDir },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// HAND-DERIVED: two checkouts of one project, the dead one named the way `git worktree add ../proj-wt` names it, so its absolute paths sort ahead of the live checkout's by construction ("proj-wt/" < "proj/" since 0x2d < 0x2f). Nothing here is read off token-goat's own matchers.
const LIB = 'export function twin(x: number): number {\n  return x * 2\n}\n'
const USE = "import { twin } from './lib'\n\nexport function useTwin(): number {\n  return twin(21)\n}\n"

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-dead-checkout-')))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-dead-checkout-home-'))
  liveDir = join(base, 'proj')
  const deadDir = join(base, 'proj-wt')
  // The fixture is indexed in this process rather than by two `index` runs of the bundle. Each spawn pays a cold start and then runs at the lowered indexing priority, which on a busy machine took longer than the hook's 60 s; what this file tests is how the read commands rank the rows, not how they got there. The rows are written through the same indexFileSync the command calls, into the database the bundle opens below (its data directory is derived from the same variables), and the data directory is pointed back afterwards.
  const pinned = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'USERPROFILE', 'HOME'] as const
  const before = pinned.map((k) => process.env[k])
  for (const k of pinned) process.env[k] = homeDir
  _resetDataDirCacheForTesting()
  try {
    const dbPath = globalDbPath()
    for (const dir of [liveDir, deadDir]) {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'lib.ts'), LIB)
      writeFileSync(join(dir, 'src', 'use.ts'), USE)
      indexFileSync(join(dir, 'src', 'lib.ts'), dbPath)
      indexFileSync(join(dir, 'src', 'use.ts'), dbPath)
      recordIndexedRoot(dir, dbPath)
    }
  } finally {
    closeAllDbs()
    pinned.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k]
      else process.env[k] = before[i]
    })
    _resetDataDirCacheForTesting()
  }
  rmSync(deadDir, { recursive: true, force: true })
})

describe('symbol NAME with a deleted checkout still in the index', () => {
  it('lists the live definition first and tags only the dead one', () => {
    const { status, stdout } = run(['symbol', 'twin'])
    expect(status).toBe(0)
    const headers = stdout.split('\n').filter((l) => l.startsWith('# twin '))
    expect(headers, stdout).toHaveLength(2)
    expect(headers[0], 'the dead checkout outranked the live file').not.toContain('proj-wt')
    expect(headers[0]).not.toContain(DELETED_MARKER)
    expect(headers[1]).toContain('proj-wt')
    expect(headers[1]).toContain(DELETED_MARKER)
  })

  it('--json puts the live row first and marks only the dead one deleted', () => {
    const { stdout } = run(['symbol', 'twin', '--json'])
    const items = (JSON.parse(stdout) as { items: { filePath: string; deleted?: boolean }[] }).items
    expect(items).toHaveLength(2)
    expect(items[0]?.filePath).not.toContain('proj-wt')
    expect(items[0] !== undefined && 'deleted' in items[0]).toBe(false)
    expect(items[1]?.deleted).toBe(true)
  })
})

describe('refs file::symbol with call sites in a deleted checkout', () => {
  it('--callers tags the dead file and lists the live one first', () => {
    const { status, stdout } = run(['refs', 'src/lib.ts::twin', '--callers'])
    expect(status).toBe(0)
    const fileHeaders = stdout.split('\n').filter((l) => /use\.ts:/.test(l) && !l.startsWith(' '))
    expect(fileHeaders, stdout).toHaveLength(2)
    expect(fileHeaders[0]).not.toContain('proj-wt')
    expect(fileHeaders[0]).not.toContain(DELETED_MARKER)
    expect(fileHeaders[1]).toContain('proj-wt')
    expect(fileHeaders[1], 'a caller in a deleted file was listed with no marker').toContain(DELETED_MARKER)
  })

  it('the per-reference listing tags the dead row the same way', () => {
    const { stdout } = run(['refs', 'src/lib.ts::twin'])
    const rows = stdout.split('\n').filter((l) => l.includes('use.ts:'))
    expect(rows, stdout).toHaveLength(2)
    expect(rows[0]).not.toContain(DELETED_MARKER)
    expect(rows[1]).toContain('proj-wt')
    expect(rows[1]).toContain(DELETED_MARKER)
  })

  it('--top tags the dead file in its ranked summary', () => {
    const { stdout } = run(['refs', 'src/lib.ts::twin', '--top', '5'])
    const dead = stdout.split('\n').find((l) => l.includes('proj-wt'))
    expect(dead, stdout).toBeDefined()
    expect(dead).toContain(DELETED_MARKER)
  })

  it('--json marks only the dead reference deleted', () => {
    const { stdout } = run(['refs', 'src/lib.ts::twin', '--json'])
    const items = (JSON.parse(stdout) as { items: { filePath: string; deleted?: boolean }[] }).items
    const dead = items.filter((i) => i.filePath.includes('proj-wt'))
    const live = items.filter((i) => !i.filePath.includes('proj-wt'))
    expect(dead.length).toBeGreaterThan(0)
    expect(live.length).toBeGreaterThan(0)
    expect(dead.every((i) => i.deleted === true)).toBe(true)
    expect(live.some((i) => 'deleted' in i)).toBe(false)
  })

  it('does not tell the caller a deleted file merely changed and will be current on a repeat', () => {
    const { stderr } = run(['refs', 'src/lib.ts::twin', '--callers'])
    expect(stderr).not.toContain('changed on disk')
    expect(stderr).toContain('no longer on disk')
  })
})
