/** A recall row written before the escape-stripped view was redacted can hold a credential whole: the old index redacted first and stripped after, and the strip joined a key a colour code split. Such a row would show in `token-goat recall`'s snippet until the 24 h prune, so the v17 -> v18 migration empties cache_recall. Checked in process and through the built bundle, whose recall command is what a user runs against a global.db an older build left behind. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, getDb, SCHEMA_VERSION } from '../src/db.js'
import Database from '../src/sqlite_driver.js'
import { BUNDLE } from './helpers/bundle.js'

// HAND-DERIVED: a GitHub personal access token shape, `ghp_` and 36 alphanumerics, written here rather than generated.
const TOKEN = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c'
const MARKER = 'prefixrecallmarker'

const tmpDirs: string[] = []

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-recall-prefix-'))
  tmpDirs.push(dir)
  return dir
}

/** Put `p` back at schema v17 holding one recall row as the old index stored it: the key whole, beside a searchable marker. */
function stampPreFixRow(p: string): void {
  const raw = new Database(p)
  raw.prepare('INSERT INTO cache_recall (cache_type, entry_id, label, content, stored_at) VALUES (?, ?, ?, ?, ?)').run('bash', 'prefix-row', 'cat .env', `${MARKER} GITHUB_TOKEN=${TOKEN}`, Date.now())
  raw.pragma('user_version = 17')
  raw.close()
}

describe('recall rows from before the redaction fix', () => {
  it('are dropped when the database is opened, and a row written after is kept', () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(17)
    const p = path.join(tmpDir(), 'global.db')
    getDb(p)
    closeDb(p)
    stampPreFixRow(p)

    const db = getDb(p)
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) AS n FROM cache_recall').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM cache_recall_fts WHERE cache_recall_fts MATCH ?').get(`"${MARKER}"`)).toEqual({ n: 0 })

    db.prepare('INSERT INTO cache_recall (cache_type, entry_id, label, content, stored_at) VALUES (?, ?, ?, ?, ?)').run('bash', 'new-row', 'ls', `${MARKER} fresh`, Date.now())
    closeDb(p)
    const reopened = getDb(p)
    expect(reopened.prepare('SELECT entry_id FROM cache_recall').all()).toEqual([{ entry_id: 'new-row' }])
    closeDb(p)
  })

  it('are not served by the built bundle\'s recall command', () => {
    const home = tmpDir()
    const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_HOME: path.join(home, 'tg'), LOCALAPPDATA: home, XDG_DATA_HOME: home, HOME: home, USERPROFILE: home }
    // Where the bundle's dataDir() resolves under the env above (constants.ts defaultDataDir).
    const dbPath = path.join(home, ...(process.platform === 'win32' ? ['dfk-helper', 'token-goat'] : ['token-goat']), 'global.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    getDb(dbPath)
    closeDb(dbPath)
    stampPreFixRow(dbPath)

    const res = spawnSync(process.execPath, [BUNDLE, 'recall', MARKER], { encoding: 'utf8', env })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout + res.stderr).not.toContain(TOKEN)
    expect(res.stdout).toContain(`No cache entries match: ${MARKER}`)
  })
})
