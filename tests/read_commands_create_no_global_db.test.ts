/** A query on a data directory nothing has been indexed into answers "nothing found" and leaves the data directory as it was. The index layer opened global.db through the creating opener, so `symbol foo` on a fresh machine left an empty global.db behind, and `doctor` then reported a database that was never built. Provenance: CAPTURE for the exit codes and message fragments (each command run through dist/token-goat.mjs in an isolated lab home on a fresh data dir, 2026-10-08); the no-file assertion is HAND-DERIVED from the contract. Writers (index, outline and skeleton, which parse the file on demand) are out of scope and keep creating the file. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')

let home: string
let project: string

function findGlobalDb(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findGlobalDb(full))
    else if (entry.name.startsWith('global.db')) found.push(full)
  }
  return found
}

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: project,
    encoding: 'utf-8',
    env: {
      ...process.env,
      TOKEN_GOAT_HOME: home,
      LOCALAPPDATA: home,
      XDG_DATA_HOME: home,
      HOME: home,
      USERPROFILE: home,
      TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
      TOKEN_GOAT_NO_WORKER_SPAWN: '1',
    },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-readnodb-home-'))
  project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-readnodb-proj-'))
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"readnodb","version":"0.0.0"}\n')
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

describe('read commands on a fresh data dir', () => {
  it.each([
    [['recall', 'foo'], 0, 'No cache entries match'],
    [['symbol', 'foo'], 1, 'No matches for "foo"'],
    [['search', 'foo'], 0, 'No results found'],
    [['semantic', 'foo'], 1, 'Matching on meaning is off'],
    [['find', 'foo'], 1, 'No indexed files match "foo"'],
    [['refs', 'foo'], 1, 'Symbol not found: "foo"'],
    [['callers', 'foo'], 1, 'Symbol not found: "foo"'],
    [['dead'], 0, 'No dead symbols found'],
    [['brief', 'a.ts::foo'], 1, 'Symbol not found: "a.ts::foo"'],
    [['types', 'a.ts'], 1, 'Could not read: "a.ts"'],
  ] as Array<[string[], number, string]>)('%j answers as before and creates no global.db', (args, status, fragment) => {
    const r = run(args)
    expect(r.out).toContain(fragment)
    expect(r.status).toBe(status)
    expect(findGlobalDb(home)).toEqual([])
  })

  it('still creates it when the command is a writer', () => {
    const r = run(['index', '.', '--walk'])
    expect(r.status, r.out).toBe(0)
    expect(findGlobalDb(home).length).toBeGreaterThan(0)
  })
})
