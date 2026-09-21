/**
 * `semantic` dropped a dense hit only when its distance exceeded DEFAULT_DISTANCE_THRESHOLD = 1.2,
 * a bound nothing reaches, so a query the corpus has no answer for still returned a full page of
 * blocks in the 0.9-1.0 band that read as results because they print exactly like real ones. The
 * floor added here makes that cut configurable and reportable. It is applied to the hits the scan
 * returns rather than inside the scan, because the scan's backfill loop retries while
 * `hits.length < topK` -- tightening the bound in there would make the weakest queries escalate k
 * to the ANN ceiling and fall through to the exact pass.
 *
 * It ships filtering nothing, which is the measured conclusion and not an omission: the two
 * populations overlap across corpus sizes, so no fixed distance separates them. The default case
 * below pins that, and the two wiring cases configure a floor explicitly rather than leaning on it.
 *
 * PROVENANCE: CAPTURE for the distance bands -- 12 genuine queries against this repo's real index
 * on 2026-09-21 had best hits from 0.635 to 0.813 and 11 off-corpus ones (nonsense strings,
 * digits, a cake recipe) from 0.820 to 1.017, while a two-file corpus in this repo's own suite
 * matches its target at 0.934, above where those two bands looked separable. HAND-DERIVED for
 * everything below: the pure-logic cases are computed from their inputs, and the wiring cases build
 * the far vector from the near one by Gram-Schmidt at a chosen angle, so its distance follows from
 * d = sqrt(2 - 2cos) on unit vectors rather than from anything the implementation reports.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import {
  embedTexts,
  ensureEmbeddingProvenance,
  insertChunkVector,
  isAvailable,
  DEFAULT_DIM,
  QUERY_INSTRUCTION_PREFIX,
  type SearchHit,
} from '../src/embeddings.js'
import { modelFilesPresent } from '../src/embed_model.js'
import { normalizePath } from '../src/paths.js'
import { loadConfig } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import { applyRelevanceFloor, runSemantic } from '../src/read_commands.js'
import Database from '../src/sqlite_driver.js'

function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return false
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

const canExerciseVec0 = vec0Working()
const canExerciseRealEmbeddings = canExerciseVec0 && isAvailable() && modelFilesPresent()

function hit(distance: number, name: string): SearchHit {
  return { filePath: `c:/r/${name}.ts`, startLine: 1, endLine: 1, kind: 'code', distance, text: name }
}

describe('applyRelevanceFloor', () => {
  it('keeps what is at or under the floor and drops the rest', () => {
    const { kept } = applyRelevanceFloor([hit(0.5, 'a'), hit(0.9, 'b'), hit(0.91, 'c')], 0.9)
    // 0.9 is kept: the floor is the worst distance still considered a match, not the first one
    // rejected. A strict comparison here would make the configured number mean something one
    // float away from what it reads as.
    expect(kept.map((h) => h.text)).toEqual(['a', 'b'])
  })

  it('reports the closest rejected distance, which is the only actionable part of an empty result', () => {
    const { kept, nearestRejected } = applyRelevanceFloor([hit(1.4, 'far'), hit(0.95, 'near'), hit(1.1, 'mid')], 0.9)
    expect(kept).toEqual([])
    // The minimum of the rejected set, not the first rejected or the overall minimum: it is what
    // tells a reader how far the floor would have to move to admit anything at all.
    expect(nearestRejected).toBe(0.95)
  })

  it('reports no rejection when nothing was rejected, so the caller cannot blame the floor for an empty scan', () => {
    const { kept, nearestRejected } = applyRelevanceFloor([hit(0.2, 'a')], 0.9)
    expect(kept).toHaveLength(1)
    expect(nearestRejected).toBeNull()
    // An empty input is the case that distinguishes "the floor removed everything" from "the scan
    // found nothing", which is the difference the warning in runSemantic keys on.
    expect(applyRelevanceFloor([], 0.9).nearestRejected).toBeNull()
  })
})

describe.skipIf(!canExerciseRealEmbeddings)('runSemantic applies the floor to its dense half', () => {
  let TMP: string

  let priorEnabled: string | undefined

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sem-floor-'))
    // The suite runs with embeddings off, so without this the dense half never runs and every
    // assertion below would pass or fail for a reason that has nothing to do with the floor.
    priorEnabled = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = '1'
    clearModuleCaches()
  })

  afterEach(() => {
    if (priorEnabled === undefined) {
      delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    } else {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = priorEnabled
    }
    closeAllDbs()
    clearModuleCaches()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  const QUERY = 'relevanceFloorProbe9k8 widget assembly'

  function norm(v: readonly number[]): number[] {
    const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return v.map((x) => x / len)
  }

  /** A unit vector at exactly `distance` from `v`, by Gram-Schmidt against a fixed alternating vector. On unit vectors the metric is d = sqrt(2 - 2cos), so cos = 1 - d^2/2 places the result at the distance asked for without consulting the implementation. */
  function atDistance(v: readonly number[], distance: number): number[] {
    const unit = norm(v)
    const raw = Array.from({ length: DEFAULT_DIM }, (_, i) => (i % 2 === 0 ? 1 : -1))
    const proj = raw.reduce((s, x, i) => s + x * (unit[i] ?? 0), 0)
    const perp = norm(raw.map((x, i) => x - proj * (unit[i] ?? 0)))
    const cos = 1 - (distance * distance) / 2
    const sin = Math.sqrt(1 - cos * cos)
    return unit.map((x, i) => cos * x + sin * (perp[i] ?? 0))
  }

  async function seed(): Promise<void> {
    const vectors = await embedTexts([QUERY_INSTRUCTION_PREFIX + QUERY])
    const near = vectors[0]
    if (near === undefined) throw new Error('embedTexts returned nothing')
    const db = getDb(globalDbPath())
    // Before inserting, not after: the first search records the embedding stack, and on a fresh
    // isolated database it finds none recorded and discards every vector as no longer describing
    // its chunks -- including the two seeded here. Recording it up front is also what keeps these
    // two cases independent, since otherwise the second only passes because the first absorbed the
    // wipe, and running either alone or under a different shard order would fail.
    ensureEmbeddingProvenance(db)
    const chunkStmt = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')

    // The near chunk carries the query's own embedding verbatim, so it sits at distance ~0 and no
    // floor under test can reach it. The far chunk is placed at 0.95, inside the band the measured
    // off-corpus queries occupy and above the 0.9 floor the case below configures.
    const a = chunkStmt.run(normalizePath(path.join(TMP, 'near.ts')), 1, 1, 'relevanceFloorProbe9k8 near chunk body', 'code')
    insertChunkVector(vecStmt, a.lastInsertRowid, near)
    const b = chunkStmt.run(normalizePath(path.join(TMP, 'far.ts')), 1, 1, 'relevanceFloorProbe9k8 far chunk body', 'code')
    insertChunkVector(vecStmt, b.lastInsertRowid, atDistance(near, 0.95))
  }

  async function run(): Promise<string> {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TMP)
    try {
      const { text } = await runSemantic(QUERY, { json: true, limit: 10, projectRoot: TMP })
      return text
    } finally {
      cwdSpy.mockRestore()
    }
  }

  /** Writes the global config, not a project `.token-goat.toml`: semantic.max_distance is in PROJECT_LOCKED_KEYS, so a repository-supplied file is refused by design and writing one here would test the lock rather than the floor. */
  function setFloor(value: number): void {
    fs.writeFileSync(path.join(path.dirname(globalDbPath()), 'config.toml'), `[semantic]\nmax_distance = ${value}\n`)
    clearModuleCaches()
  }

  it('ships a default that filters nothing, so no corpus loses an answer to a number nobody chose', () => {
    // The point of the default, asserted rather than left to the reader: every distance this metric
    // can produce between unit vectors is at or under 2, and the measured genuine matches run from
    // 0.635 on a large index to 0.934 on a two-file one. A default below that spread would remove
    // real answers on small projects silently, which is why the floor ships inert and opt-in.
    expect(loadConfig().semantic.max_distance).toBe(1.2)
  })

  it('drops a hit above a configured floor while keeping the one below it', async () => {
    await seed()
    setFloor(0.9)
    const payload = JSON.parse(await run()) as { items: Array<{ filePath: string }> }
    const paths = payload.items.map((i) => i.filePath).join('\n')
    expect(paths).toContain('near.ts')
    // Without the floor this row is returned and printed identically to the one above it. Asserting
    // its absence rather than a count is what makes the case specific to the floor: a scan that
    // returned nothing at all would fail the near.ts assertion first.
    expect(paths).not.toContain('far.ts')
  })

  it('returns the same hit once the configured floor admits it, so the number is what decides', async () => {
    await seed()
    setFloor(1.1)
    const payload = JSON.parse(await run()) as { items: Array<{ filePath: string }> }
    const paths = payload.items.map((i) => i.filePath).join('\n')
    // The same seeded row, the same query, the same index -- only the configured floor moved. This
    // is the control for the case above: it proves the row was withheld by the floor rather than
    // missing from the scan for some unrelated reason.
    expect(paths).toContain('far.ts')
  })
})
