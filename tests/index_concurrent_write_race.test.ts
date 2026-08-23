/**
 * Regression test for the concurrent cold-start indexing race.
 *
 * `writeParseResult` wrapped its deletes and inserts in `db.transaction(...)` and called it plainly.
 * The driver issues a plain call as a deferred `BEGIN`: the transaction takes a read snapshot at
 * its first statement and only asks for the write lock when it reaches a writing one. SQLite refuses
 * that upgrade with `SQLITE_BUSY` immediately and never consults the busy handler, because retrying
 * cannot help -- the snapshot the transaction is holding is already stale. So `busy_timeout` did
 * nothing for it, and several `index` runs starting together against a database that did not exist
 * yet would leave one of them failing on a file with "database is locked". Worse, the failure was
 * silent from the outside: `cmdIndex` counts a failed file and carries on, so the command still
 * exited 0 with that file missing from the index and no reason to look.
 *
 * Spawning real OS processes is the whole point. The failure needs one process to commit between
 * another's snapshot and its first write, which nothing in a single-threaded test can arrange:
 * the driver is synchronous, so two connections in one process never interleave inside a
 * transaction. An in-process test of two connections contending for the lock does not reproduce it
 * either -- plain lock contention consults the busy handler and waits, exactly as it should. Only
 * the stale-snapshot upgrade fails instantly, and only genuine concurrency produces one.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ROOT } from './helpers/bundle.js'
import { tsxProcessArgs } from './helpers/tsx_process.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'fixtures', 'index_race_worker.ts')

// Six writers over sixty files apiece. The count matters: the window between a transaction's
// snapshot and its first write is small, so a handful of files would hit it only sometimes. This
// shape failed on every one of ten pre-fix runs while taking a few seconds.
const WORKERS = 6
const FILES = 60

let tmpHome: string
let srcDir: string
let dbPath: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idxrace-'))
  srcDir = path.join(tmpHome, 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  dbPath = path.join(tmpHome, 'index.db')
  for (let i = 0; i < FILES; i++) {
    // Real parseable content with several symbols each, so every file is an actual write of
    // several rows rather than a no-op that would barely hold the lock.
    fs.writeFileSync(
      path.join(srcDir, `mod${i}.ts`),
      `export function alpha${i}(x: number): number {\n  return x + ${i}\n}\n` +
        `export function beta${i}(x: number): number {\n  return alpha${i}(x) * 2\n}\n` +
        `export const gamma${i} = ${i}\n`,
    )
  }
})

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/** Spawn one indexing process; resolves with everything it printed to stdout. */
function runWorker(barrierPath: string, onReady: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // Loading tsx through Node avoids the tsx CLI's IPC socket, which is denied in restricted
    // macOS sandboxes even though the worker itself needs no IPC.
    const child = spawn(process.execPath, tsxProcessArgs(WORKER, dbPath, srcDir, String(FILES), barrierPath), {
      cwd: ROOT,
      env: { ...process.env, TOKEN_GOAT_HOME: tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    // Reported once per child: stderr accumulates, so every later chunk still contains the marker
    // and an unguarded call would let one talkative worker satisfy the whole barrier by itself.
    let reportedReady = false
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (!reportedReady && stderr.includes('ready')) {
        reportedReady = true
        onReady()
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`index race worker exited with code ${code}: ${stderr}`))
    })
  })
}

describe('several processes indexing into one database that does not exist yet', () => {
  it('writes every file instead of losing one to "database is locked"', async () => {
    // Every worker loads its modules and then waits at the barrier, so all six reach the database
    // within a few milliseconds of each other instead of whenever their own startup happened to
    // finish. Two separate defects live in that window -- the deferred `BEGIN` in writeParseResult
    // and the WAL conversion in getDb -- and both need the processes genuinely overlapping. Without
    // the barrier this test found the second of them in about one run in four.
    const barrierPath = path.join(tmpHome, 'go')
    let readyCount = 0
    let releaseWhenAllReady: () => void = () => {}
    const allReady = new Promise<void>((resolve) => {
      releaseWhenAllReady = resolve
    })
    const onReady = (): void => {
      readyCount += 1
      if (readyCount >= WORKERS) releaseWhenAllReady()
    }

    const running = Array.from({ length: WORKERS }, () => runWorker(barrierPath, onReady))
    // Racing the workers so a crash before the barrier fails with that crash rather than hanging.
    await Promise.race([allReady, Promise.all(running)])
    fs.writeFileSync(barrierPath, 'go')

    const outputs = await Promise.all(running)

    const failures = outputs
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('FAILED '))
    expect(failures).toEqual([])

    // The dropped file was the real damage, and it is invisible in the exit code, so assert on the
    // index itself rather than only on the absence of an error message.
    const { getDb } = await import('../src/db.js')
    const db = getDb(dbPath)
    const indexed = db
      .prepare(`SELECT DISTINCT file_path FROM symbols`)
      .all()
      .map((r) => path.basename((r as { file_path: string }).file_path))
    const missing: string[] = []
    for (let i = 0; i < FILES; i++) {
      if (!indexed.includes(`mod${i}.ts`)) missing.push(`mod${i}.ts`)
    }
    expect(missing).toEqual([])
  }, 120_000)
})
