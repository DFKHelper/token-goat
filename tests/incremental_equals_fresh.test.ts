/** An index kept current by the worker, one drained batch of edits at a time, holds the same rows as an index built from scratch over the final tree. A seeded create/modify/rename/delete sequence runs through the real `drainOnce` with no injected callback (so `makeIndexer`, `makeRemover` and `indexFileSync` are the production ones), and the result is compared with a fresh `cmdIndex` of the final tree into a second database. Drift here is a ghost or stale symbol that no unit test sees. Embeddings are ON (the isolated test home turns them off, this file turns them back on) with only the embedding backend stubbed, so the `chunks` rows are compared too; vectors and autoincrement ids are excluded from the comparison, and the vector count is checked against the chunk count instead. `sections` is not a table of its own: markdown headings are stored as `symbols` rows, so they are covered by the symbols comparison and the test pins that the final tree really produced some. PROVENANCE: HAND-DERIVED. The file contents are rendered by `render` below from small unit lists (a function, class or heading per unit, each calling another name) that were written from the TypeScript, Python, Go and Markdown grammars, not from any extractor in `src/`; the independent oracle is the model's own unit names, asserted present for every live file, plus the fresh `cmdIndex` index (a different entry path over the same `indexFileSync`). The seed comes from `TG_INCREMENTAL_SEED` or a random draw, and every assertion message and a failing run's error carry it. Waits are on events (`pendingEmbeddings()`), never on time. */

import { execFileSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { appendDirtyQueuePaths } from '../src/dirty_queue.js'
import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

type Ext = 'ts' | 'py' | 'go' | 'md'
interface Unit {
  name: string
  call: string
  n: number
}
interface Spec {
  ext: Ext
  lead: number
  units: Unit[]
}

const EXTS: Ext[] = ['ts', 'py', 'go', 'md']
const DIR_OF: Record<Ext, string> = { ts: 'lib', py: 'pkg', go: 'cmd', md: 'docs' }
const STEMS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']
const INITIAL_FILES = 20
const EDITS = 30
const HELPERS = ['helper0', 'helper1', 'helper2', 'helper3']

const SEED = process.env['TG_INCREMENTAL_SEED'] !== undefined ? Number(process.env['TG_INCREMENTAL_SEED']) : randomInt(1, 2 ** 31)

// mulberry32, a public-domain 32-bit PRNG; any seeded generator would do, the point is that a failing seed replays.
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function render(stem: string, spec: Spec): string {
  const blank = '\n'.repeat(spec.lead)
  const u = spec.units
  switch (spec.ext) {
    case 'ts':
      return blank + u.map((x, i) => `export function ${x.name}(x: number): number {\n  const y = ${x.call}(x)\n  return y + ${x.n}\n}\n${i % 2 === 1 ? `\nexport class K${x.name} {\n  run(): number {\n    return ${x.name}(${x.n})\n  }\n}\n` : ''}`).join('\n')
    case 'py':
      return blank + u.map((x, i) => (i % 2 === 0 ? `def ${x.name}(x):\n    y = ${x.call}(x)\n    return y + ${x.n}\n` : `class ${x.name}:\n    def run(self):\n        return ${x.call}(${x.n})\n`)).join('\n\n')
    case 'go':
      return `package ${stem}\n\n${blank}` + u.map((x) => `func ${x.name}(x int) int {\n\ty := ${x.call}(x)\n\treturn y + ${x.n}\n}\n`).join('\n')
    case 'md':
      return `${blank}# ${stem} notes\n` + u.map((x, i) => `\n## ${x.name}\n\nSee ${x.call} for ${x.n} details.\n${i % 2 === 1 ? `\n### ${x.name} detail\n\nMore on ${x.call}.\n` : ''}`).join('')
  }
}

// realpathSync.native so the base is the OS's own spelling; the Windows runner reports an 8.3 short name (RUNNER~1) otherwise.
const TMP_BASE = fs.realpathSync.native(os.tmpdir())
let ROOT: string
let PROJ: string
let DATA: string
let FRESH_DB: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(TMP_BASE, 'tg-incr-fresh-'))
  PROJ = path.join(ROOT, 'proj')
  DATA = path.join(ROOT, 'data')
  FRESH_DB = path.join(ROOT, 'fresh', 'global.db')
  fs.mkdirSync(PROJ, { recursive: true })
  fs.mkdirSync(DATA, { recursive: true })
  fs.mkdirSync(path.dirname(FRESH_DB), { recursive: true })
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts); chunks only exist with them on.
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
  fs.rmSync(ROOT, { recursive: true, force: true })
})

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: PROJ, stdio: 'ignore' })
}

const abs = (rel: string): string => normalizePath(path.join(PROJ, rel))

/** Rows as sorted JSON tuples, so two databases compare as multisets whatever their autoincrement ids. */
function tuples(dbPath: string, sql: string): string[] {
  return (getDb(dbPath).prepare(sql).all() as Record<string, unknown>[]).map((r) => JSON.stringify(Object.values(r))).sort()
}

const TABLES: Record<string, string> = {
  symbols: 'SELECT file_path, name, line_start, line_end, kind, parent, docstring, body FROM symbols',
  refs: 'SELECT file_path, name, line, col, context FROM refs',
  chunks: 'SELECT file_path, start_line, end_line, kind, text FROM chunks',
  files: 'SELECT path, language, sha, parser_sha, embed_sha FROM files',
}

function onlyIn(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>()
  for (const r of b) counts.set(r, (counts.get(r) ?? 0) + 1)
  const extra: string[] = []
  for (const r of a) {
    const left = counts.get(r) ?? 0
    if (left > 0) counts.set(r, left - 1)
    else extra.push(r)
  }
  return extra
}

/** Rows in the vec0 table; the chunk-row assertion earlier in the run has already failed by name where sqlite-vec is absent. */
function vectorCount(dbPath: string): number {
  return getDb(dbPath).prepare('SELECT COUNT(*) FROM chunk_vectors').pluck().get() as number
}

type EditKind = 'create' | 'modify' | 'rename' | 'delete'

/** The edit kinds of one run: one of each guaranteed, the rest drawn 20/45/15/20 with deletes capped so the tree never shrinks below its floor, then shuffled. Pure in the rng, so a seed replays and every seed covers all four kinds. */
function editSchedule(rng: () => number, edits: number): EditKind[] {
  const out: EditKind[] = ['create', 'modify', 'rename', 'delete']
  let deletes = 1
  while (out.length < edits) {
    const roll = rng()
    if (roll < 0.2) out.push('create')
    else if (roll < 0.65) out.push('modify')
    else if (roll < 0.8) out.push('rename')
    else if (deletes < 8) {
      deletes += 1
      out.push('delete')
    } else out.push('modify')
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j] as EditKind, out[i] as EditKind]
  }
  return out
}

/** Everything a second drain must leave alone, ids included. */
function fullSnapshot(dbPath: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [t, order] of [['symbols', 'id'], ['refs', 'id'], ['chunks', 'id'], ['files', 'path']] as const) {
    const cols = t === 'files' ? 'path, sha, language, parser_sha, embed_sha' : '*'
    out[t] = (getDb(dbPath).prepare(`SELECT ${cols} FROM ${t} ORDER BY ${order}`).all() as Record<string, unknown>[]).map((r) => JSON.stringify(Object.values(r)))
  }
  out['vectors'] = [String(vectorCount(dbPath))]
  return out
}

interface Plan {
  live: Map<string, Spec>
  renames: [string, string][]
  batches: { edits: string[]; queued: string[] }[]
}

describe('the edit schedule', () => {
  it('gives seeds 1 to 40 thirty edits each, covering create, modify, rename and delete', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = editSchedule(makeRng(seed), EDITS)
      expect(s, `seed ${seed}`).toHaveLength(EDITS)
      expect([...new Set(s)].sort(), `seed ${seed}`).toEqual(['create', 'delete', 'modify', 'rename'])
      expect(s.filter((k) => k === 'delete').length, `seed ${seed}`).toBeLessThanOrEqual(8)
    }
  })
})

describe('an incremental drain equals a fresh index', () => {
  it('leaves the rows a fresh cmdIndex of the final tree writes, and a second drain changes nothing', async () => {
    const msg = (what: string): string => `seed ${SEED} (rerun with TG_INCREMENTAL_SEED=${SEED}): ${what}`
    try {
      await run(msg)
    } catch (err) {
      if (err instanceof Error && !err.message.includes(`seed ${SEED}`)) err.message = msg(err.message)
      throw err
    }
  })

  async function run(msg: (what: string) => string): Promise<void> {
    const rng = makeRng(SEED)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T
    let serial = 0
    const newUnit = (stem: string, ext: Ext, earlier: Unit[]): Unit => {
      serial += 1
      return { name: `${stem}${ext}U${serial}`, call: rng() < 0.4 && earlier.length > 0 ? (pick(earlier) as Unit).name : pick(HELPERS), n: Math.floor(rng() * 90) + 10 }
    }
    const newSpec = (stem: string, ext: Ext): Spec => {
      const units: Unit[] = []
      for (let i = 0, k = 1 + Math.floor(rng() * 3); i < k; i++) units.push(newUnit(stem, ext, units))
      return { ext, lead: Math.floor(rng() * 2), units }
    }
    const relOf = (stem: string, ext: Ext): string => `${DIR_OF[ext]}/${stem}.${ext}`
    const stemOf = (rel: string): string => path.basename(rel, path.extname(rel))
    const extOf = (rel: string): Ext => path.extname(rel).slice(1) as Ext

    const plan: Plan = { live: new Map(), renames: [], batches: [] }
    let pending: string[] = []
    const write = (rel: string, spec: Spec): void => {
      fs.mkdirSync(path.dirname(path.join(PROJ, rel)), { recursive: true })
      fs.writeFileSync(path.join(PROJ, rel), render(stemOf(rel), spec))
      plan.live.set(rel, spec)
    }
    const enqueue = (...rels: string[]): void => {
      appendDirtyQueuePaths(DATA, rels.map(abs))
      pending.push(...rels)
    }
    const freeRels = (): string[] => STEMS.flatMap((s) => EXTS.map((e) => relOf(s, e))).filter((r) => !plan.live.has(r))
    const drain = async (): Promise<number> => {
      const queueFile = path.join(DATA, 'queue', 'dirty.txt')
      const queued = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8') : ''
      for (const rel of pending) expect(queued, msg(`${rel} was not in the dirty queue before the drain`)).toContain(abs(rel))
      pending = []
      // Real default path: no index or remove callback is injected.
      const processed = drainOnce(DATA)
      await pendingEmbeddings()
      return processed
    }

    // Initial population: about twenty files, drained in one batch.
    const firstFree = freeRels()
    for (let i = 0; i < INITIAL_FILES; i++) {
      const rel = firstFree.splice(Math.floor(rng() * firstFree.length), 1)[0] as string
      write(rel, newSpec(stemOf(rel), extOf(rel)))
      enqueue(rel)
    }
    expect(await drain(), msg('the initial drain indexed nothing')).toBeGreaterThan(0)

    // Thirty edits in drained batches of one to four.
    const schedule = editSchedule(rng, EDITS)
    let done = 0
    let drainedEdits = 0
    while (done < EDITS) {
      const size = Math.min(1 + Math.floor(rng() * 4), EDITS - done)
      const edits: string[] = []
      for (let i = 0; i < size; i++) {
        const lives = [...plan.live.keys()].sort()
        const kind = schedule[done + i] as EditKind
        if (kind === 'create') {
          const rel = pick(freeRels())
          write(rel, newSpec(stemOf(rel), extOf(rel)))
          enqueue(rel)
          edits.push(`create ${rel}`)
        } else if (kind === 'modify') {
          const rel = pick(lives)
          const spec = plan.live.get(rel) as Spec
          const how = Math.floor(rng() * 4)
          const units = spec.units.map((u) => ({ ...u }))
          if (how === 0) units.push(newUnit(stemOf(rel), spec.ext, units))
          else if (how === 1 && units.length > 1) units.splice(Math.floor(rng() * units.length), 1)
          else if (how === 2) units.forEach((u) => (u.n += 1))
          const next: Spec = { ext: spec.ext, lead: how === 3 ? (spec.lead + 1) % 3 : spec.lead, units }
          write(rel, next)
          enqueue(rel)
          edits.push(`modify ${rel}`)
        } else if (kind === 'rename') {
          const rel = pick(lives)
          const sameExt = freeRels().filter((r) => extOf(r) === extOf(rel))
          const to = pick(sameExt)
          const spec = plan.live.get(rel) as Spec
          fs.mkdirSync(path.dirname(path.join(PROJ, to)), { recursive: true })
          fs.renameSync(path.join(PROJ, rel), path.join(PROJ, to))
          plan.live.delete(rel)
          // The package-name line of a Go file follows its stem, so the renamed copy is re-rendered rather than moved.
          write(to, spec)
          plan.renames.push([rel, to])
          // A rename is two dirty paths: the old spelling to prune and the new one to index.
          enqueue(rel, to)
          edits.push(`rename ${rel} -> ${to}`)
        } else {
          const rel = pick(lives)
          fs.rmSync(path.join(PROJ, rel))
          plan.live.delete(rel)
          enqueue(rel)
          edits.push(`delete ${rel}`)
        }
      }
      done += size
      drainedEdits += edits.length
      plan.batches.push({ edits, queued: [...pending] })
      await drain()
    }
    expect(drainedEdits, msg('the sequence did not run the planned number of edits')).toBe(EDITS)
    const kinds = new Set(plan.batches.flatMap((b) => b.edits.map((e) => e.split(' ')[0])))
    expect([...kinds].sort(), msg('the executed sequence did not exercise every edit kind though editSchedule guarantees each')).toEqual(['create', 'delete', 'modify', 'rename'])
    for (const [from, to] of plan.renames) {
      const batch = plan.batches.find((b) => b.edits.some((e) => e === `rename ${from} -> ${to}`))
      expect(batch?.queued, msg(`rename ${from} -> ${to} did not enqueue both paths`)).toEqual(expect.arrayContaining([from, to]))
    }

    // Independent oracle: the model's own unit names must be indexed for every live file, and no row may name a path the tree no longer has.
    const live = [...plan.live.keys()].sort()
    const incrementalFiles = getDb(path.join(DATA, 'global.db')).prepare('SELECT path FROM files ORDER BY path').pluck().all() as string[]
    expect(incrementalFiles, msg('files rows differ from the files the model says are live')).toEqual(live.map(abs).sort())
    for (const rel of live) {
      const names = new Set(getDb(path.join(DATA, 'global.db')).prepare('SELECT name FROM symbols WHERE file_path = ?').pluck().all(abs(rel)) as string[])
      for (const u of (plan.live.get(rel) as Spec).units) {
        expect(names.has(u.name),msg(`${rel}: unit ${u.name} has no symbol row after the drains`)).toBe(true)
      }
    }

    // The fresh index of the final tree, through the other shipping entry point.
    git('init')
    git('add', '-A')
    await cmdIndex(PROJ, { dbPath: FRESH_DB, embed: true })

    const incrementalDb = path.join(DATA, 'global.db')
    for (const [table, sql] of Object.entries(TABLES)) {
      const inc = tuples(incrementalDb, sql)
      const fresh = tuples(FRESH_DB, sql)
      expect(fresh.length, msg(`the fresh index wrote no ${table} rows (for chunks: sqlite-vec or onnxruntime is probably missing on this machine), so equality below would prove nothing`)).toBeGreaterThan(0)
      const diff = { onlyIncremental: onlyIn(inc, fresh).slice(0, 8), onlyFresh: onlyIn(fresh, inc).slice(0, 8) }
      expect(diff, msg(`${table} rows differ between the incremental drains and a fresh index`)).toEqual({ onlyIncremental: [], onlyFresh: [] })
    }
    const markdownRows = tuples(incrementalDb, "SELECT file_path, name FROM symbols WHERE file_path LIKE '%.md'")
    expect(markdownRows.length, msg('no markdown heading rows, so the sections half of the comparison is empty')).toBeGreaterThan(0)
    const chunkCount = getDb(incrementalDb).prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number
    const vectors = vectorCount(incrementalDb)
    expect(vectors, msg('chunk_vectors rows do not match chunks rows after the drains')).toBe(chunkCount)

    // A second drain, even with every path re-queued, changes nothing: not a row, not an id.
    const before = fullSnapshot(incrementalDb)
    enqueue(...live, ...plan.renames.map(([from]) => from))
    expect(await drain(), msg('re-draining unchanged paths reported work')).toBe(0)
    expect(await drain(), msg('draining an empty queue reported work')).toBe(0)
    expect(fullSnapshot(incrementalDb), msg('a second drain changed rows')).toEqual(before)
  }
})
