// The database --json listings fence their envelope one string at a time, and the per-string fence read the config twice for each string: loadConfig re-reads both config files and the config env vars on every call, so a 401-table `sqlite-schema --json` made about 36,600 reads and ran 30 s on Windows, again for every size the overflow cap tried. Each listing now reads it once per envelope it renders.

// HAND-DERIVED: the bound is the number of tables the fixture holds. Every table (and every column of wide_table) is several strings, keys included, and the per-string fence read the config at least twice for each, so it could not finish under one read per table; one read per rendered envelope, about log2 of the table count of them, plus the command's own handful stays far below it. Counting reads rather than timing them keeps the test independent of machine speed and load.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as ConfigModule from '../src/config.js'

const reads = vi.hoisted(() => ({ count: 0 }))

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>()
  return {
    ...actual,
    loadConfig: (...args: Parameters<typeof actual.loadConfig>) => {
      reads.count++
      return actual.loadConfig(...args)
    },
  }
})

import { run } from '../src/cli.js'
import { invalidateConfigCache } from '../src/config.js'
import Database from '../src/sqlite_driver.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const TABLES = 100

let root: string
let stdoutSpy: WriteSpy | undefined
let stderrSpy: WriteSpy | undefined

beforeAll(() => {
  process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '1000'
  invalidateConfigCache()
  root = mkdtempSync(join(tmpdir(), 'tg-json-config-reads-'))
  const db = new Database(join(root, 'many.db'))
  db.transaction(() => {
    for (let i = 0; i < TABLES; i++) db.exec(`CREATE TABLE table_with_a_long_name_${i} (id INTEGER PRIMARY KEY, value_${i} TEXT)`)
    db.exec(`CREATE TABLE wide_table (${Array.from({ length: TABLES }, (_, i) => `column_with_a_long_name_${i} TEXT`).join(', ')})`)
  })()
  db.close()
})

afterEach(() => {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
  invalidateConfigCache()
})

describe('database --json listings read the config once per envelope, not per string', () => {
  const cases: ReadonlyArray<readonly [string, readonly [string, string, ...string[]]]> = [
    ['sqlite-schema', ['sqlite-schema', 'many.db', '--json']],
    ['describe', ['describe', 'many.db', '--json']],
    ['sqlite-tables', ['sqlite-tables', 'many.db', '--json']],
    ['describe <table>', ['describe', 'many.db', 'wide_table', '--json']],
  ]

  for (const [name, [command, file, ...rest]] of cases) {
    it(name, async () => {
      const stdout: string[] = []
      const stderr: string[] = []
      stdoutSpy = spyOnWrite(process.stdout, stdout)
      stderrSpy = spyOnWrite(process.stderr, stderr)
      process.exitCode = 0
      reads.count = 0
      await run(['node', 'token-goat', command, join(root, file), ...rest])
      const count = reads.count
      expect(process.exitCode ?? 0, stderr.join('')).toBe(0)
      // The listing was cut, so the cap rendered and measured several candidate envelopes, which is where per-string reads multiplied.
      expect(JSON.parse(stdout.join(''))).toHaveProperty('truncated', true)
      expect(count, `${name} --json read the config ${count} times for ${TABLES} tables`).toBeLessThan(TABLES)
    })
  }
})
