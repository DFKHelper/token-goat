/** A file the worker parsed but never embedded is embedded later, without anyone touching it again. The drain parses synchronously and queues each file's embed in memory. A worker stopped with that queue non-empty drops it: a SIGTERM waits five seconds, and on Windows `worker stop` terminates the process with no wait at all. Every dropped file keeps a NULL `files.embed_sha`, and before this fix nothing ever revisited one, because the drain only sees files something touches again. On the live index this left 25,840 of aws-cdk's 27,051 files without embeddings, all parsed inside one eleven-minute window on 2026-09-23, and `semantic` searched the other 7%. Driven on the real default wiring: `runWorkerLoop` with its own drain and indexer, no injected callback. Only the embedding backend is stubbed (`setPipelineFnForTesting`, as tests/embed_gate_independent_of_parser_stamp.test.ts does), because the model is not what this is about. A stamp the configuration has since overtaken is the same backlog by another route, so the sweep asks makeIndexer's own freshness gate rather than looking for NULL alone: a `disabled:` stamp left from while embeddings were off is owed an embed once they are back on, and a current stamp is not. Provenance: HAND-DERIVED. The fixture is a forty-function source file; the lost-backlog state (a `files` row with its content sha and a NULL `embed_sha`, no chunk rows) is written by this test after a real index, and matches the aws-cdk rows read from the live ledger on 2026-09-24: `embed_sha IS NULL` for 25,840 rows, no `chunks` for them. The overtaken stamp is FORMAT-DERIVED: written with `disabledEmbedSha`, the producer the indexer itself stamps with (src/parser.ts). */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, isAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { disabledEmbedSha } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings, runWorkerLoop } from '../src/worker.js'

// PROVENANCE: HAND-DERIVED. Forty one-line exported functions: more than one chunk, far under any size threshold.
const SOURCE = Array.from({ length: 40 }, (_, i) => `export function backlogFn${i}(): number { return ${i} }`).join('\n') + '\n'

// Same three-state classification tests/embed_gate_independent_of_parser_stamp.test.ts uses: 'absent' is a legitimate platform skip, 'broken' would be silent-dead semantic search and must fail rather than hide.
function classifyVec0(): 'working' | 'broken' | 'absent' {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return 'working'
  } catch {
    return 'broken'
  }
}

const canExerciseRealEmbed = classifyVec0() === 'working' && isAvailable()

let TMP: string
let DB_PATH: string
let SRC: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  // Not under the OS temp dir: the sweep drops temp-dir paths, as every other enqueue does, and this test is about the ones it keeps. tests/.tg-* is gitignored.
  TMP = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.tg-embed-backlog-'))
  DB_PATH = path.join(TMP, 'global.db')
  SRC = normalizePath(path.join(TMP, 'backlog.ts'))
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts); the backlog only exists with them on.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function chunkCount(): number {
  return getDb(DB_PATH).prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number
}

function embedSha(): string | null {
  return getDb(DB_PATH).prepare('SELECT embed_sha FROM files').pluck().get() as string | null
}

/** Index the fixture for real, then put it in the state a stopped worker leaves: parsed, embed dropped. */
async function parsedButNeverEmbedded(): Promise<void> {
  fs.writeFileSync(SRC, SOURCE, 'utf8')
  for (const args of [['init'], ['add', '-A']]) spawnSync('git', args, { cwd: TMP, encoding: 'utf-8' })
  fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${SRC}\n`)
  expect(drainOnce(TMP)).toBe(1)
  await pendingEmbeddings()
  // Calibration: the real embed path ran once, so the NULL below is the dropped-backlog state rather than a file the embedder never handles.
  expect(chunkCount(), 'the fixture produced no chunks, so a re-embed could not be observed').toBeGreaterThan(1)
  const db = getDb(DB_PATH)
  db.exec('DELETE FROM chunk_vectors; DELETE FROM chunks; UPDATE files SET embed_sha = NULL')
  expect(queuedPaths(), 'the queue must be empty, so only the sweep can bring the file back').toEqual([])
}

function queuedPaths(): string[] {
  const queue = path.join(TMP, 'queue', 'dirty.txt')
  return fs.existsSync(queue) ? fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean) : []
}

/** Run the real loop until `done` holds or `maxCycles` pass, then let any embed it started settle. */
async function runLoopUntil(done: () => boolean, maxCycles: number): Promise<void> {
  let cycles = 0
  await runWorkerLoop(TMP, 10, () => {
    cycles += 1
    return cycles > maxCycles || (cycles % 5 === 0 && done())
  })
  await pendingEmbeddings()
}

it('sqlite-vec is not installed-but-broken, which would skip the suite below while semantic search is dead', () => {
  expect(classifyVec0()).not.toBe('broken')
})

describe.skipIf(!canExerciseRealEmbed)('the embed backlog a stopped worker drops', () => {
  it('is picked up by the next worker and embedded, with nothing touching the file', async () => {
    await parsedButNeverEmbedded()
    const sha = getDb(DB_PATH).prepare('SELECT sha FROM files').pluck().get() as string

    await runLoopUntil(() => chunkCount() > 0, 200)

    expect(chunkCount(), 'the parsed-but-unembedded file stayed out of semantic search').toBeGreaterThan(1)
    expect(embedSha()).toBe(sha)
  })

  // The same unrevisited backlog by another route: a stamp the configuration has since overtaken. Turning embeddings back on leaves every file stamped while they were off out of 'semantic' until something touches it.
  it('includes a file stamped while embeddings were off, once they are back on', async () => {
    await parsedButNeverEmbedded()
    const sha = getDb(DB_PATH).prepare('SELECT sha FROM files').pluck().get() as string
    getDb(DB_PATH).prepare('UPDATE files SET embed_sha = ?').run(disabledEmbedSha(sha))

    await runLoopUntil(() => chunkCount() > 0, 200)

    expect(chunkCount(), 'the file stamped while embeddings were off stayed out of semantic search').toBeGreaterThan(1)
    expect(embedSha()).toBe(sha)
  })

  it('leaves a file whose stamp is current alone', async () => {
    await parsedButNeverEmbedded()
    const sha = getDb(DB_PATH).prepare('SELECT sha FROM files').pluck().get() as string
    // Stamped as embedded with no chunks, which is what a file with nothing to embed looks like: requeueing it would re-read it on every worker start for no result.
    getDb(DB_PATH).prepare('UPDATE files SET embed_sha = ?').run(sha)

    let requeued = false
    let cycles = 0
    await runWorkerLoop(TMP, 10, () => {
      requeued ||= queuedPaths().length > 0
      cycles += 1
      return cycles > 20
    })
    await pendingEmbeddings()

    expect(requeued).toBe(false)
    expect(chunkCount()).toBe(0)
  })

  it('is left alone while embeddings are off, rather than stamped as disabled wholesale', async () => {
    await parsedButNeverEmbedded()
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'

    await runLoopUntil(() => false, 20)

    expect(embedSha()).toBeNull()
    expect(chunkCount()).toBe(0)
  })
})
