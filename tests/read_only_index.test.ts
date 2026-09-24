/** The read commands answer from an index this process cannot write: a read-only sandbox, or a data directory whose permissions deny writes. They used to open the index read-write like every writer does, so the WAL switch in db.ts's initConnection failed ("db: failed to enable WAL mode (unable to open database file)", after its full 15 s retry) and `read`, `symbol`, `semantic` and `answer` all exited 1 with no answer. The writers must still refuse the same index. Everything runs against a real on-disk index built by the shipping bundle, made unwritable for real (an ACL on Windows, chmod elsewhere; see tests/helpers/seal-directory.ts), because the failure lives in how SQLite opens a WAL database it cannot write, which no stub reproduces. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { allowReadOnlyIndex, getDb, isReadOnlyDb } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { allowWrites, denyWrites } from './helpers/seal-directory.js'

const NOTICE = 'reads it without writing'

// HAND-DERIVED: a two-symbol module written for this test; the assertions name symbols and a body line from it, not anything derived from token-goat's own parser output.
const WIDGET_TS = [
  '/** Returns the widget display label. */',
  'export function widgetLabel(name: string): string {',
  '  return `widget:${name}`',
  '}',
  '',
  'export class WidgetStore {',
  '  private items = new Map<string, number>()',
  '  addWidget(name: string): number {',
  '    this.items.set(name, 1)',
  '    return this.items.size',
  '  }',
  '}',
  '',
].join('\n')

let base: string
let project: string
let dbPath: string
let dataDir: string
let env: NodeJS.ProcessEnv

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ro-index-'))
  project = path.join(base, 'proj')
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, 'widget.ts'), WIDGET_TS)
  env = tgIsolatedEnv(base, { TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' })
  const indexed = runBundle(['index', '.', '--walk'], { cwd: project, env, timeout: 120_000 })
  expect(indexed.status, indexed.stderr).toBe(0)
  const found = findGlobalDb(base)
  if (found === null) throw new Error(`no global.db under ${base}`)
  dbPath = found
  dataDir = path.dirname(found)
  // A clean close deletes -wal and -shm, which is the state the harder case below needs; check it rather than assume it.
  expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
})

afterAll(() => {
  allowWrites(dataDir)
  fs.rmSync(base, { recursive: true, force: true })
})

/** Run `fn` with the data directory write-denied, or skip the calling test with the reason when this runner cannot deny writes (root ignores chmod). */
function whileUnwritable(skip: (reason: string) => void, fn: () => void): void {
  if (!denyWrites(dataDir)) {
    skip('this runner can still write a directory denied to it (root or an elevated account), so the index cannot be made unwritable here')
    return
  }
  try {
    fn()
  } finally {
    allowWrites(dataDir)
  }
}

const READS: Array<{ args: string[]; expect: string }> = [
  { args: ['read', 'widget.ts::widgetLabel'], expect: 'return `widget:${name}`' },
  { args: ['symbol', 'addWidget'], expect: 'addWidget' },
  { args: ['semantic', 'widgetLabel'], expect: 'widgetLabel' },
  { args: ['answer', 'where is widgetLabel defined'], expect: 'widget.ts' },
]

function expectAnswersReadOnly(): void {
  for (const r of READS) {
    const res = runBundle(r.args, { cwd: project, env, timeout: 60_000 })
    expect(res.status, `${r.args.join(' ')}: ${res.stderr}`).toBe(0)
    expect(res.stdout, r.args.join(' ')).toContain(r.expect)
    expect(res.stderr.split(NOTICE)).toHaveLength(2)
  }
}

describe('read commands on an index this process cannot write', () => {
  // The state a clean close leaves: no -wal or -shm beside the database, and a directory that cannot hold new ones. A plain read-only open needs them, so this is the case the `immutable` open exists for.
  it('answer with exit 0 and say once that the index is read without writing, when no -wal/-shm exist', ({ skip }) => {
    whileUnwritable(skip, () => {
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
      expectAnswersReadOnly()
    })
  })

  // The state a live index is usually in: another connection holds it open, so -wal and -shm exist. SQLite's read-write open of a write-protected file quietly becomes read-only here and would answer, then fail at its first write with nothing said.
  it('answer the same way while another connection keeps -wal/-shm in place', ({ skip }) => {
    const holder = new DatabaseSync(dbPath)
    try {
      holder.prepare('SELECT count(*) FROM symbols').get()
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true)
      whileUnwritable(skip, expectAnswersReadOnly)
    } finally {
      holder.close()
    }
  })

  // A file changed since indexing sends a read down the reindex-on-read path, which writes. It must be skipped, and the stale warning must not promise a reindex that never ran.
  it('serve a changed file from the older index and say so, rather than reindex it', ({ skip }) => {
    fs.appendFileSync(path.join(project, 'widget.ts'), 'export const addedLater = 1\n')
    try {
      whileUnwritable(skip, () => {
        const read = runBundle(['read', 'widget.ts::widgetLabel'], { cwd: project, env, timeout: 60_000 })
        expect(read.status, read.stderr).toBe(0)
        expect(read.stdout).toContain('return `widget:${name}`')
        expect(read.stdout).toContain('⚠ STALE: index is older than the file on disk and cannot be updated this run')
        expect(read.stdout).not.toContain('retry shortly')
        const forced = runBundle(['read', 'widget.ts::widgetLabel', '--force-refresh'], { cwd: project, env, timeout: 60_000 })
        expect(forced.status, forced.stderr).toBe(0)
        expect(forced.stdout).toContain('⚠ STALE: index is older than the file on disk and cannot be updated this run')
        const symbol = runBundle(['symbol', 'widgetLabel'], { cwd: project, env, timeout: 60_000 })
        expect(symbol.status, symbol.stderr).toBe(0)
        expect(symbol.stdout).toContain('⚠ STALE: file changed on disk and could not be reindexed')
        const semantic = runBundle(['semantic', 'widgetLabel'], { cwd: project, env, timeout: 60_000 })
        expect(semantic.status, semantic.stderr).toBe(0)
        expect(semantic.stderr).toContain('the index is read-only this run, so these results are from the older version.')
        expect(semantic.stderr).not.toContain('a reindex just ran')
      })
    } finally {
      fs.writeFileSync(path.join(project, 'widget.ts'), WIDGET_TS)
    }
  })

  it('leave the indexer failing loudly on the same index', ({ skip }) => {
    whileUnwritable(skip, () => {
      fs.appendFileSync(path.join(project, 'widget.ts'), '// changed\n')
      try {
        const res = runBundle(['index', '.', '--walk'], { cwd: project, env, timeout: 90_000 })
        expect(res.status).not.toBe(0)
        expect(res.stderr).toMatch(/failed to enable WAL mode|readonly database|EACCES|EPERM/)
        expect(res.stderr).not.toContain(NOTICE)
      } finally {
        fs.writeFileSync(path.join(project, 'widget.ts'), WIDGET_TS)
      }
    })
  }, 120_000)
})

describe('the read-only connection stays with the process that asked for it', () => {
  it('is never handed to a writer once the permission is gone: the indexer then throws', ({ skip }) => {
    whileUnwritable(skip, () => {
      let notices = 0
      allowReadOnlyIndex(() => notices++)
      try {
        const conn = getDb(dbPath)
        expect(isReadOnlyDb(dbPath)).toBe(true)
        expect(conn.prepare("SELECT name FROM symbols WHERE name = 'widgetLabel'").get()).toEqual({ name: 'widgetLabel' })
        expect(() => conn.exec('CREATE TABLE ro_probe (x)')).toThrow(/readonly/)
        getDb(dbPath)
        expect(notices).toBe(1)
      } finally {
        clearModuleCaches()
      }
      expect(isReadOnlyDb(dbPath)).toBe(false)
      expect(() => indexFileSync(path.join(project, 'widget.ts'), dbPath)).toThrow()
      clearModuleCaches()
    })
  }, 120_000)

  // Migrations cannot run without write access, and serving an older schema would skip ones a reader depends on (the v10 -> v11 purge of embedded .env values among them).
  it('refuses an index stamped with an older schema version instead of serving it', ({ skip }) => {
    const raw = new DatabaseSync(dbPath)
    const version = Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    raw.exec(`PRAGMA user_version = ${version - 1}`)
    raw.close()
    try {
      whileUnwritable(skip, () => {
        allowReadOnlyIndex(() => undefined)
        try {
          expect(() => getDb(dbPath)).toThrow(/predates this token-goat build/)
          expect(isReadOnlyDb(dbPath)).toBe(false)
        } finally {
          clearModuleCaches()
        }
      })
    } finally {
      const restore = new DatabaseSync(dbPath)
      restore.exec(`PRAGMA user_version = ${version}`)
      restore.close()
    }
  })
})
