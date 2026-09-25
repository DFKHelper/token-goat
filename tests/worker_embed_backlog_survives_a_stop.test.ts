/** A file the worker parsed but never embedded is embedded later, without anyone touching it again. The drain parses synchronously and queues each file's embed in memory. A worker stopped with that queue non-empty drops it: a SIGTERM waits five seconds, and on Windows `worker stop` terminates the process with no wait at all. Every dropped file keeps a NULL `files.embed_sha`, and before this fix nothing ever revisited one, because the drain only sees files something touches again. On the live index this left 25,840 of aws-cdk's 27,051 files without embeddings, all parsed inside one eleven-minute window on 2026-09-23, and `semantic` searched the other 7%. Driven on the real default wiring: `runWorkerLoop` with its own drain and indexer, no injected callback. Only the embedding backend is stubbed (`setPipelineFnForTesting`, as tests/embed_gate_independent_of_parser_stamp.test.ts does), because the model is not what this is about. A stamp the configuration has since overtaken is the same backlog by another route, so the sweep asks makeIndexer's own freshness gate rather than looking for NULL alone: a `disabled:` stamp left from while embeddings were off is owed an embed once they are back on, and a current stamp is not. Provenance: HAND-DERIVED. The fixture is a forty-function source file; the lost-backlog state (a `files` row with its content sha and a NULL `embed_sha`, no chunk rows) is written by this test after a real index, and matches the aws-cdk rows read from the live ledger on 2026-09-24: `embed_sha IS NULL` for 25,840 rows, no `chunks` for them. The overtaken stamp is FORMAT-DERIVED: written with `disabledEmbedSha`, the producer the indexer itself stamps with (src/parser.ts). */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NodeFsModule from 'node:fs'

import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, isAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { disabledEmbedSha } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings, runWorkerLoop } from '../src/worker.js'

// A pass-through `node:fs` whose append to the dirty queue can be made to fail, the way a full disk or a queue file held by a scanner fails it. `vi.spyOn` cannot redefine a property of a builtin's ESM namespace, so the module is replaced at resolution time instead, as tests/guards/dirty_queue_append_is_constant_time.test.ts does.
const appendFault = vi.hoisted(() => ({ failQueueAppends: false, refused: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  const appendFileSync = (file: Parameters<typeof actual.appendFileSync>[0], ...rest: unknown[]): void => {
    if (appendFault.failQueueAppends && String(file).endsWith('dirty.txt')) {
      appendFault.refused += 1
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
    ;(actual.appendFileSync as (...a: unknown[]) => void)(file, ...rest)
  }
  return { ...actual, default: { ...actual, appendFileSync }, appendFileSync }
})

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
  appendFault.failQueueAppends = false
  appendFault.refused = 0
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

  // A drive that is only unmounted looks exactly like a deleted file to a stat. Queueing its files hands them to the drain, which prunes an absent path's rows outright, so one idle sweep would erase the index of every project on a disconnected drive; sweepKnownRoots is the one place allowed to decide that, and it waits out a grace period first. PROVENANCE: HAND-DERIVED, a row copied from the real one onto a path whose whole root does not exist. Under TMP it would not model a drive: TMP is a reachable root, and a file missing under a reachable root really was deleted, which the root sweep prunes at once.
  it('does not queue a file that is not on disk, so a disconnected drive keeps its index', async () => {
    await parsedButNeverEmbedded()
    const gone = normalizePath(path.join(`${TMP}-unmounted-drive`, 'project', 'kept.ts'))
    getDb(DB_PATH)
      .prepare('INSERT INTO files (path, sha, mtime, language, indexed_at, embed_sha, parser_sha) SELECT ?, sha, mtime, language, indexed_at, NULL, parser_sha FROM files WHERE path = ?')
      .run(gone, SRC)

    await runLoopUntil(() => chunkCount() > 0, 200)

    expect(chunkCount(), 'calibration: the sweep ran and embedded the file that is on disk').toBeGreaterThan(1)
    expect(getDb(DB_PATH).prepare('SELECT COUNT(*) FROM files WHERE path = ?').pluck().get(gone), 'the unreachable file lost its index row').toBe(1)
  })

  // The walk only moves forward, so a batch that never reached the queue has to be read again rather than stepped past: otherwise the files in it wait for the next worker start. PROVENANCE: HAND-DERIVED, the append made to fail with the ENOSPC a full disk returns.
  it('reads a batch again when putting it on the queue failed', async () => {
    await parsedButNeverEmbedded()
    appendFault.failQueueAppends = true

    await runLoopSwitchingAt(10, () => (appendFault.failQueueAppends = false), () => chunkCount() > 0, 200)

    expect(appendFault.refused, 'calibration: the sweep tried to queue the file while appends failed').toBeGreaterThan(0)
    expect(chunkCount(), 'the file whose batch failed to queue was never embedded').toBeGreaterThan(1)
  })

  // Embeddings switched on while a worker is running must not have to wait for the next worker start to fill in what was indexed while they were off.
  it('scans once embeddings are switched on under a running worker', async () => {
    await parsedButNeverEmbedded()
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'

    await runLoopSwitchingAt(10, () => (process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'), () => chunkCount() > 0, 200)

    expect(chunkCount(), 'the file indexed while embeddings were off stayed out of semantic search').toBeGreaterThan(1)
  })

  // The walk ends once it has read every file, and a finished walk is where a long-running worker spends nearly all its life. Files indexed while embeddings were then switched off owe an embed as much as the ones a stop dropped, so switching them back on has to start the walk again rather than find it finished. PROVENANCE: HAND-DERIVED, the file put back into the state an index taken with embeddings off leaves (chunks gone, a `disabled:` stamp) after the first walk had embedded it and finished.
  it('scans again when embeddings come back on after the walk has finished', async () => {
    await parsedButNeverEmbedded()
    const db = getDb(DB_PATH)
    const sha = db.prepare('SELECT sha FROM files').pluck().get() as string
    let cycles = 0
    let stage: 'first walk' | 'off' | 'back on' = 'first walk'
    let switchedOffAt = 0
    await runWorkerLoop(TMP, 10, () => {
      cycles += 1
      if (stage === 'first walk' && cycles % 5 === 0 && chunkCount() > 0 && embedSha() === sha) {
        stage = 'off'
        switchedOffAt = cycles
        process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
        db.exec('DELETE FROM chunk_vectors; DELETE FROM chunks')
        db.prepare('UPDATE files SET embed_sha = ?').run(disabledEmbedSha(sha))
      } else if (stage === 'off' && cycles === switchedOffAt + 10) {
        stage = 'back on'
        process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      }
      return cycles > 400 || (stage === 'back on' && cycles % 5 === 0 && chunkCount() > 0)
    })
    await pendingEmbeddings()

    expect(stage, 'calibration: the first walk embedded the file and finished').toBe('back on')
    expect(chunkCount(), 'the file indexed while embeddings were off stayed out of semantic search after the walk had finished').toBeGreaterThan(1)
    expect(embedSha()).toBe(sha)
  })

  // The loop only looks at the configuration on an idle cycle, and a cycle that drained something is not one. Embeddings switched off, a file edited and reindexed, embeddings switched back on, all before the worker next went idle: no idle cycle ever saw them off, and the edited file keeps its `disabled:` marker unless the marker itself is what re-arms the walk. PROVENANCE: HAND-DERIVED, an edit queued and drained while the configuration says off, with the switch back made before the next idle cycle.
  it('scans again when embeddings were off and back on while the worker was busy', async () => {
    await parsedButNeverEmbedded()
    const db = getDb(DB_PATH)
    const sha = db.prepare('SELECT sha FROM files').pluck().get() as string
    let cycles = 0
    let stage: 'first walk' | 'edited while off' | 'back on' = 'first walk'
    let editedSha: string | null = null
    await runWorkerLoop(TMP, 10, () => {
      cycles += 1
      if (stage === 'first walk' && cycles % 5 === 0 && chunkCount() > 0 && embedSha() === sha) {
        stage = 'edited while off'
        process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
        fs.appendFileSync(SRC, 'export const editedWhileOff = 1\n')
        fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${SRC}\n`)
      } else if (stage === 'edited while off') {
        // The cycle that ran since is the drain, so no idle cycle has run with embeddings off.
        stage = 'back on'
        editedSha = db.prepare('SELECT sha FROM files').pluck().get() as string
        process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
        expect(embedSha(), 'calibration: the drain stamped the edit as indexed while embeddings were off').toBe(disabledEmbedSha(editedSha))
      }
      return cycles > 400 || (stage === 'back on' && cycles % 5 === 0 && embedSha() === editedSha)
    })
    await pendingEmbeddings()

    expect(editedSha, 'calibration: the edit was reindexed').not.toBe(sha)
    expect(embedSha(), 'the file edited while embeddings were briefly off stayed out of semantic search').toBe(editedSha)
    expect(chunkCount()).toBeGreaterThan(1)
  })
})

/** One run of the real loop that calls `flip` at cycle `at`, so state a cycle carried over (the backlog cursor) is what is under test, then runs until `done` or `maxCycles`. */
async function runLoopSwitchingAt(at: number, flip: () => void, done: () => boolean, maxCycles: number): Promise<void> {
  let cycles = 0
  await runWorkerLoop(TMP, 10, () => {
    cycles += 1
    if (cycles === at) flip()
    return cycles > maxCycles || (cycles > at && cycles % 5 === 0 && done())
  })
  await pendingEmbeddings()
}
