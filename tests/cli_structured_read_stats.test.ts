/**
 * Regression: json-query, json-outline, yaml-query, yaml-outline, openapi-op, openapi-outline,
 * zip-list, zip-read, sqlite-query, sqlite-schema, and conflicts (all in read_commands.ts) never
 * called recordStat -- each reads a file and emits a narrower slice, the same "read replacement"
 * shape as csv-query/coverage-report-gaps (see cli_csv_query_stats.test.ts,
 * cli_coverage_report_gaps_stats.test.ts), but had no stats wiring at all, so their buckets in
 * `token-goat stats --full` stayed permanently zero regardless of real usage (same class of gap
 * fixed for csv_query/coverage_report_gaps/map_lookup/changed_lookup, see
 * project_runchanged_missing_stat memory). Drives the real, unmocked `run()` CLI entrypoint
 * against real scratch fixtures and asserts a real stats row appears via summarize() against the
 * real (test-isolated) global stats DB -- a synthetic recordStat/DB insert would not catch the
 * original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import Database from 'better-sqlite3'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

describe('structured-data read command stat recording', () => {
  let root: string
  const cwd = process.cwd()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-statrec-structured-'))
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  })

  async function expectStatRecorded(kind: string, before: () => Promise<void>) {
    const beforeEvents = summarize(30).by_kind[kind]?.events ?? 0
    await before()
    const after = summarize(30).by_kind[kind]
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  }

  it('json-outline records a json_outline stat row', async () => {
    const file = join(root, 'data.json')
    writeFileSync(file, JSON.stringify({ a: 1, b: [1, 2, 3] }))
    await expectStatRecorded('json_outline', async () => {
      await run(['node', 'token-goat', 'json-outline', file])
    })
  })

  it('json-query records a json_query stat row', async () => {
    const file = join(root, 'data.json')
    writeFileSync(file, JSON.stringify({ a: { b: 42 } }))
    await expectStatRecorded('json_query', async () => {
      await run(['node', 'token-goat', 'json-query', file, 'a.b'])
    })
  })

  it('yaml-outline records a yaml_outline stat row', async () => {
    const file = join(root, 'data.yaml')
    writeFileSync(file, 'a: 1\nb:\n  - 1\n  - 2\n')
    await expectStatRecorded('yaml_outline', async () => {
      await run(['node', 'token-goat', 'yaml-outline', file])
    })
  })

  it('yaml-query records a yaml_query stat row', async () => {
    const file = join(root, 'data.yaml')
    writeFileSync(file, 'a:\n  b: 42\n')
    await expectStatRecorded('yaml_query', async () => {
      await run(['node', 'token-goat', 'yaml-query', file, 'a.b'])
    })
  })

  it('openapi-outline records an openapi_outline stat row', async () => {
    const file = join(root, 'spec.json')
    writeFileSync(
      file,
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 't', version: '1' },
        paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } },
      }),
    )
    await expectStatRecorded('openapi_outline', async () => {
      await run(['node', 'token-goat', 'openapi-outline', file])
    })
  })

  it('openapi-op records an openapi_op stat row', async () => {
    const file = join(root, 'spec.json')
    writeFileSync(
      file,
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 't', version: '1' },
        paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } },
      }),
    )
    await expectStatRecorded('openapi_op', async () => {
      await run(['node', 'token-goat', 'openapi-op', file, 'ping'])
    })
  })

  it('zip-list records a zip_list stat row', async () => {
    const file = join(root, 'archive.zip')
    writeFileSync(file, zipSync({ 'a.txt': strToU8('hello\n') }))
    await expectStatRecorded('zip_list', async () => {
      await run(['node', 'token-goat', 'zip-list', file])
    })
  })

  it('zip-read records a zip_read stat row', async () => {
    const file = join(root, 'archive.zip')
    writeFileSync(file, zipSync({ 'a.txt': strToU8('hello\n') }))
    await expectStatRecorded('zip_read', async () => {
      await run(['node', 'token-goat', 'zip-read', file, 'a.txt'])
    })
  })

  it('sqlite-schema records a sqlite_schema stat row', async () => {
    const file = join(root, 'fixture.db')
    const db = new Database(file)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    db.close()
    await expectStatRecorded('sqlite_schema', async () => {
      await run(['node', 'token-goat', 'sqlite-schema', file])
    })
  })

  it('sqlite-query records a sqlite_query stat row', async () => {
    const file = join(root, 'fixture.db')
    const db = new Database(file)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    db.prepare('INSERT INTO t (id, name) VALUES (1, ?)').run('x')
    db.close()
    await expectStatRecorded('sqlite_query', async () => {
      await run(['node', 'token-goat', 'sqlite-query', file, 'SELECT * FROM t'])
    })
  })

  it('conflicts records a conflicts stat row', async () => {
    const file = join(root, 'conflicted.ts')
    writeFileSync(file, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n')
    await expectStatRecorded('conflicts', async () => {
      process.chdir(root)
      await run(['node', 'token-goat', 'conflicts', file])
    })
  })
})
