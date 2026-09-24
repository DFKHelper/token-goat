/** A read served from a write-protected index leaves nothing behind in a data directory that still takes writes. With the whole directory write-denied (tests/read_only_index.test.ts) every write a read path attempts fails and is swallowed, so a missing guard is invisible there: removing any one of the reindex-on-read heal's, the stats schema bootstrap's or recordStat's read-only checks left that suite green. A write-protected index file in a writable directory is the state where each of them has somewhere to write, which is what this test looks at. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { indexableDir } from './helpers/temp-config.js'

// HAND-DERIVED: a one-symbol module written for this test; the assertion names a body line from it, not anything derived from token-goat's own parser output.
const WIDGET_TS = ['export function widgetLabel(name: string): string {', '  return `widget:${name}`', '}', ''].join('\n')

let base: string
let project: string
let dbPath: string
let dataDir: string
let env: NodeJS.ProcessEnv

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ro-trace-'))
  // Outside the OS temp dir, because the dirty queue drops any path under it and the heal's queue write would then have nothing to show.
  project = indexableDir()
  fs.writeFileSync(path.join(project, 'widget.ts'), WIDGET_TS)
  env = tgIsolatedEnv(base, { TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' })
  const indexed = runBundle(['index', '.', '--walk'], { cwd: project, env, timeout: 120_000 })
  expect(indexed.status, indexed.stderr).toBe(0)
  const found = findGlobalDb(base)
  if (found === null) throw new Error(`no global.db under ${base}`)
  dbPath = found
  dataDir = path.dirname(found)
})

afterAll(() => {
  try {
    fs.chmodSync(dbPath, 0o644)
  } catch {
    // Already writable, or never created.
  }
  fs.rmSync(base, { recursive: true, force: true })
})

/** Every file under the data directory against its size, so a write the read made shows up as a new or grown entry. */
function snapshot(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    out.set(path.relative(dir, full), fs.statSync(full).size)
  }
  return out
}

describe('a read against a write-protected index in a data directory that takes writes', () => {
  it('serves the stale rows and leaves no queued reindex, stats row or stats failure behind', () => {
    // `index` never creates the stats tables; the first stats write does. So the stats schema bootstrap has DDL to run on this index, which a read-only connection refuses.
    const db = new DatabaseSync(dbPath)
    const statsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stats'").get()
    db.close()
    expect(statsTable).toBeUndefined()
    // A changed file sends the read down the reindex-on-read path, which queues the file for the worker once it has reparsed it.
    fs.appendFileSync(path.join(project, 'widget.ts'), 'export const addedLater = 1\n')
    const before = snapshot(dataDir)
    fs.chmodSync(dbPath, 0o444)
    let res: ReturnType<typeof runBundle>
    try {
      res = runBundle(['read', 'widget.ts::widgetLabel'], { cwd: project, env, timeout: 60_000 })
    } finally {
      fs.chmodSync(dbPath, 0o644)
    }
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('return `widget:${name}`')
    expect(res.stdout).toContain('⚠ STALE: index is older than the file on disk and cannot be updated this run')
    expect(res.stderr).toContain('reads it without writing')
    const after = snapshot(dataDir)
    // SQLite's read-only connection creates its own -shm and an empty -wal when the directory lets it; a -wal with anything in it would be a committed write.
    expect(after.get('global.db-wal') ?? 0).toBe(0)
    const changed = [...after]
      .filter(([name, size]) => before.get(name) !== size && name !== 'global.db-shm' && name !== 'global.db-wal')
      .map(([name]) => name)
    expect(changed).toEqual([])
  })
})
