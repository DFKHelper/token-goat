/**
 * `token-goat reconcile` must find rows a parser upgrade left stale, not only rows whose content
 * moved.
 *
 * `reconcileProject`'s drift sweep used to compare content (mtime, then sha) only. A parser change
 * (new syntax extracted, a fixed extraction bug) invalidates every already-indexed file whose
 * BYTES never moved but whose symbol/ref rows were written by the old extractor -- `files.sha`
 * cannot see that, because it never changes. `files.parser_sha` exists to answer exactly this
 * question (see parser_fingerprint_gate.test.ts), and per-file freshness gates in worker.ts/cli.ts
 * already consult it -- but nothing FOUND those rows for a file nobody edits after the bump. This
 * is the same failure shape as an earlier fix in this repo ("a freshness gate that fails closed and
 * queues nothing misses forever", content-only key left 37/237 stale): documented once, and it
 * recurred on the parse side because the fix was never enforced by a guard.
 *
 * Provenance: CAPTURE. The stale fingerprint is written directly into the real indexed database
 * (the shape a binary upgrade leaves: same bytes on disk, an old parser_sha on the row), then the
 * real built bundle's `reconcile` command is run against it and its actual stdout/JSON is asserted
 * on -- this drives the true default path end to end (index -> stale row -> reconcile -> enqueued
 * -> worker drain -> symbols repopulated), not an injected callback.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { drainOnce } from '../src/worker.js'
import { querySymbols } from '../src/index_reader.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function json(args: string[]): Record<string, unknown> {
  const r = run([...args, '--json'])
  try {
    return JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return expect.fail(`\`${args.join(' ')} --json\` emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

/** Every path currently sitting in the dirty queue, or [] when the queue file does not exist. Searched under the isolated home rather than a hardcoded layout, so it stays correct if that layout ever changes -- an empty result must mean "nothing queued", never "looked in the wrong place". */
function findDirtyQueue(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findDirtyQueue(full)
      if (found !== null) return found
    } else if (entry.name === 'dirty.txt') return full
  }
  return null
}

function dirtyQueue(): string[] {
  const queue = findDirtyQueue(homeDir)
  if (queue === null) return []
  return readFileSync(queue, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

/** The one real global.db the isolated home produced, opened directly to inspect files.parser_sha the way a real developer would when auditing a suspiciously-stale index. */
function findGlobalDb(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findGlobalDb(full)
      if (found !== null) return found
    } else if (entry.name === 'global.db') return full
  }
  return null
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-parser-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-parser-home-'))

  writeFileSync(join(projectDir, 'widget.ts'), 'export function widget(): number {\n  return 1\n}\n')
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')

  const indexed = run(['index', '.'])
  expect(indexed.code, `indexing the fixture failed: ${indexed.err.slice(0, 400)}`).toBe(0)
})

describe('reconcile against a parser upgrade', () => {
  it('calibration: a real symbol resolves before the fixture is made stale, so the cases below prove something', () => {
    const r = run(['symbol', 'widget'])
    expect(r.out, 'the fixture never indexed in the first place; the staleness case below proves nothing').toContain('widget')

    // Calibration for the parser-only cases below: a content-only diff must find nothing on a
    // freshly indexed project. Checked BEFORE any parser_sha is stamped stale, or a sweep that
    // already flagged everything as changed would make every later case pass for the wrong reason.
    const clean = json(['reconcile', '--dry-run'])
    expect(clean.changed, 'a freshly indexed project reported drift with nothing stale yet').toEqual([])
  })

  it('finds a file whose content never moved but whose rows carry an old parser fingerprint', () => {
    const dbPath = findGlobalDb(homeDir)
    expect(dbPath, 'no global.db was created by the fixture index run').not.toBeNull()
    // getDb, not a bare sqlite handle: the schema's triggers call the TG_LOWER custom function
    // getDb registers on the connection it opens, and a raw connection that skips that
    // registration fails on the very first DML against a path-indexed table.
    const db = getDb(dbPath as string)
    db.prepare("UPDATE files SET parser_sha = '0000000000000000' WHERE path LIKE '%widget.ts'").run()

    const r = json(['reconcile', '--dry-run'])
    const changedNames = (r.changed as string[]).map((p) => p.replace(/\\/g, '/').split('/').pop())
    expect(changedNames, 'reconcile did not report the parser-stale file as drift').toContain('widget.ts')
    expect(r.parserStale, 'the parser-stale count was not reported').toBeGreaterThan(0)
  })

  it('enqueues the parser-stale file for reindexing (not just --dry-run reporting it)', () => {
    const dbPath = findGlobalDb(homeDir)
    const db = getDb(dbPath as string)
    db.prepare("UPDATE files SET parser_sha = '0000000000000000' WHERE path LIKE '%widget.ts'").run()

    const beforeQueue = dirtyQueue().length
    const real = json(['reconcile'])
    expect(real.enqueued, 'a parser-stale file was found but nothing was enqueued').toBeGreaterThan(0)
    expect(dirtyQueue().length, 'the parser-stale file never reached the dirty queue').toBeGreaterThan(beforeQueue)
  })

  it('end to end: drains the queue with the real default indexer, reparses with the current parser, and the row converges', () => {
    const dbPath = findGlobalDb(homeDir)
    expect(dbPath).not.toBeNull()
    const db = getDb(dbPath as string)
    db.prepare("UPDATE files SET parser_sha = '0000000000000000' WHERE path LIKE '%widget.ts'").run()

    // Drop the symbol row too, the same "before" shape parser_fingerprint_gate.test.ts uses: a
    // stale files.parser_sha with symbols still sitting from the old parse would let this test
    // pass even if drainOnce never actually reparsed anything.
    const before = db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }
    expect(before.n, 'the fixture must have at least one indexed symbol, or emptiness proves nothing later').toBeGreaterThan(0)
    db.prepare('DELETE FROM symbols').run()

    const beforeQueue = dirtyQueue().length
    const real = json(['reconcile'])
    expect(real.enqueued, 'the parser-stale file was found but nothing was enqueued').toBeGreaterThan(0)
    const queueFile = findDirtyQueue(homeDir)
    expect(queueFile, 'reconcile enqueued but no dirty queue file exists').not.toBeNull()
    expect(dirtyQueue().length, 'the parser-stale file never reached the dirty queue').toBeGreaterThan(beforeQueue)

    // Drive the REAL default worker drain path: drainOnce with no injected index/remove callback
    // resolves to makeIndexer(dbPath)/makeRemover(dbPath), the exact production default the
    // detached daemon's own loop uses (worker.ts::runWorkerLoop) -- this is deliberately NOT a
    // test-supplied callback, which is the injected-seam trap CLAUDE.md's critical-path note
    // warns this exact pipeline has shipped broken behind before. `dir` is derived from the queue
    // file drainOnce itself defines the layout for (dir/queue/dirty.txt, dir/global.db), not
    // re-derived from dataDir()/env: this test process's own dataDir() is fixed at import time by
    // tests/setup/isolate-home.ts and would not point at this fixture's isolated home dir.
    const drainDir = dirname(dirname(queueFile as string))
    const processed = drainOnce(drainDir)
    expect(processed, 'drainOnce reported nothing processed for a queue that was just populated').toBeGreaterThan(0)

    const row = db.prepare("SELECT parser_sha FROM files WHERE path LIKE '%widget.ts'").get() as { parser_sha: string } | undefined
    expect(row?.parser_sha, 'the drain ran but the row was never reparsed with the current fingerprint').not.toBe('0000000000000000')

    // The actual point of the fix: symbols were dropped above, and only a real reparse rebuilds
    // them -- querying the exact fixture DB, not a fresh one, so this can only pass if drainOnce
    // truly reparsed the file rather than merely touching the files row.
    const resolved = querySymbols({ name: 'widget' }, dbPath as string)
    expect(resolved.length, 'the symbol was not rebuilt by the drain that was supposed to repair it').toBeGreaterThan(0)
  })
})
