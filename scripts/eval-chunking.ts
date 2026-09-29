/** Chunking hillclimb against the golden retrieval set (evals/retrieval/golden.jsonl). Re-chunks the corpus under each candidate configuration through the production chunker (`chunkFile`, with the boundaries `buildEmbeddingBoundaries` derives from the index), embeds every chunk with the production `embedTexts`, and ranks each query the way `searchSemantic` does: the prefixed query vector, the L2 over-fetch, the distance threshold, then `rerankHits`. The only difference from production is that the nearest-neighbour search is a brute-force scan in memory rather than a vec0 query, which returns the same set for vectors this few. Nothing here writes to an index: this is a measurement, and its output is a recommendation that someone then makes by hand in src/embeddings.ts.

A configuration replaces the baseline only when the paired bootstrap interval of its MRR@10 delta clears zero on the train split and its test-split delta is positive too, so a change fitted to the train queries has to survive the held-out ones. Embedding is deterministic, so an A/A run of the baseline gives a delta of exactly zero; the script measures that rather than assuming it (re-embedding a sample of chunks and every query with the cache bypassed) and reports the largest vector difference it saw, which is what licenses reading the bootstrap interval as the whole noise floor.

Run it under an isolated home that already holds an index of --root, since the symbol boundaries come from that index: `TOKEN_GOAT_HOME=... LOCALAPPDATA=... npx tsx scripts/eval-chunking.ts --root . --out report.json`. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globalDbPath } from '../src/constants.js'
import { buildEmbeddingBoundaries } from '../src/embedding_boundaries.js'
import { DEFAULT_MODEL, EmbeddingModel } from '../src/embed_model.js'
import {
  chunkFile,
  DEFAULT_DISTANCE_THRESHOLD,
  embedTexts,
  MAX_CHUNK_CHARS,
  MAX_CHUNK_TOKENS,
  MAX_OVER_FETCH,
  mergeNearbyHits,
  OVER_FETCH_FACTOR,
  QUERY_INSTRUCTION_PREFIX,
  rerankHits,
  type Chunk,
  type SearchHit,
} from '../src/embeddings.js'
import { canonicalizeIndexPath } from '../src/parser.js'
import { resolveLabel, type GoldenLabel } from '../evals/retrieval/labels.js'
import { bootstrapCI, firstRelevantRank, mean, pairedBootstrapDelta, reciprocalRank, hitAtK, splitOf, type Interval, type RelevantSpan } from '../evals/retrieval/metrics.js'

const K = 10

export interface ChunkConfig {
  readonly name: string
  /** Token budget per chunk. Production is MAX_CHUNK_TOKENS. */
  readonly tokens: number
  /** Overlap in characters between consecutive window chunks. Production is 200. */
  readonly overlap: number
  /** Whether chunk cuts snap to symbol and heading boundaries. Production does. */
  readonly boundaries: boolean
}

export const BASELINE: ChunkConfig = { name: 'baseline', tokens: MAX_CHUNK_TOKENS, overlap: 200, boundaries: true }

/** `chunkFile` caps a chunk at MAX_CHUNK_TOKENS and takes no budget argument, so a smaller budget `tokens` is imposed by inflating the count it sees: a text of n real tokens reads as n * MAX_CHUNK_TOKENS / tokens, and fits exactly when n <= tokens. Rounded up, so a text one token over the budget never rounds back under it. */
export function scaledCounter(count: (text: string) => number, tokens: number): (text: string) => number {
  if (tokens >= MAX_CHUNK_TOKENS) return count
  return (text) => Math.ceil((count(text) * MAX_CHUNK_TOKENS) / tokens)
}

/** Euclidean distance, the metric the vec0 `chunk_vectors` table is declared with. */
export function l2(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    s += d * d
  }
  return Math.sqrt(s)
}

/** The `k` nearest vectors within `maxDistance`, nearest first, ties kept in corpus order. This is what `fetchScopedHits` asks vec0 for. */
export function nearest(query: ArrayLike<number>, vectors: readonly ArrayLike<number>[], k: number, maxDistance: number): { index: number; distance: number }[] {
  const scored: { index: number; distance: number }[] = []
  vectors.forEach((v, index) => {
    const distance = l2(query, v)
    if (distance <= maxDistance) scored.push({ index, distance })
  })
  scored.sort((x, y) => x.distance - y.distance || x.index - y.index)
  return scored.slice(0, k)
}

export interface Verdict {
  readonly accept: boolean
  readonly reason: string
}

/** Whether a candidate replaces the incumbent: its train delta interval must sit above zero and its test delta must be positive. A train-only gain is overfitting to the queries it was tuned on, and a test-only gain was not what the search selected for. */
export function decide(train: Interval, test: Interval): Verdict {
  if (!(train.lo > 0)) return { accept: false, reason: `train delta ${fmt(train)} does not clear zero` }
  if (!(test.mean > 0)) return { accept: false, reason: `train clears zero but test delta ${fmt(test)} is not positive` }
  return { accept: true, reason: `train ${fmt(train)} clears zero and test ${fmt(test)} agrees` }
}

function fmt(i: Interval): string {
  return `${i.mean.toFixed(3)} [${i.lo.toFixed(3)}, ${i.hi.toFixed(3)}]`
}

interface GoldenQuery {
  readonly id: string
  readonly query: string
  readonly kind: string
  readonly relevant: readonly GoldenLabel[]
}

interface QueryScore {
  readonly id: string
  readonly split: 'train' | 'test'
  readonly rr: number
  readonly hit: number
  readonly rrMerged: number
  readonly bytes: number
}

interface ConfigResult {
  readonly config: ChunkConfig
  readonly chunks: number
  readonly scores: readonly QueryScore[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** The corpus: every tracked TypeScript file under src/ and the Markdown the golden labels draw on. CHANGELOG*.md is left out because it is 2.1 MB of release notes no label points into, and it would double the embedding bill for a distractor set. */
function corpusFiles(root: string): string[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/)
  return tracked.filter((f) => (f.startsWith('src/') && f.endsWith('.ts')) || (/^(?:docs\/)?[^/]+\.md$/.test(f) && !/^CHANGELOG/i.test(f)))
}

class VectorCache {
  private readonly map = new Map<string, Float32Array>()
  private dirty = 0
  constructor(private readonly file: string | undefined) {
    if (file !== undefined && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) this.map.set(k, new Float32Array(Buffer.from(v, 'base64').buffer.slice(0)))
    }
  }

  get size(): number {
    return this.map.size
  }

  async embed(texts: readonly string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]> {
    const keys = texts.map(sha)
    const missing = [...new Set(keys.filter((k) => !this.map.has(k)))]
    const byKey = new Map<string, string>()
    texts.forEach((t, i) => byKey.set(keys[i] ?? '', t))
    const BATCH = 64
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      const vecs = await embedTexts(batch.map((k) => byKey.get(k) ?? ''))
      batch.forEach((k, j) => this.map.set(k, Float32Array.from(vecs[j] ?? [])))
      this.dirty += batch.length
      onProgress?.(Math.min(i + BATCH, missing.length), missing.length)
      if (this.dirty >= 2000) this.save()
    }
    return keys.map((k) => this.map.get(k) ?? new Float32Array())
  }

  save(): void {
    if (this.file === undefined || this.dirty === 0) return
    const out: Record<string, string> = {}
    for (const [k, v] of this.map) out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
    writeFileSync(this.file, JSON.stringify(out))
    this.dirty = 0
  }
}

async function main(): Promise<void> {
  const root = path.resolve(arg('root') ?? '.')
  const out = arg('out')
  const cache = new VectorCache(arg('cache'))
  const dbPath = globalDbPath()
  const model = await EmbeddingModel.load(DEFAULT_MODEL)
  const realCount = (t: string): number => model.countTokens(t)

  const files = corpusFiles(root).map((rel) => {
    const abs = canonicalizeIndexPath(path.join(root, rel))
    const content = readFileSync(path.join(root, rel), 'utf8')
    return { rel, abs, content, boundaries: buildEmbeddingBoundaries(abs, content, dbPath) }
  })
  const withBoundaries = files.filter((f) => f.boundaries.length > 0).length
  console.error(`corpus: ${files.length} files, ${withBoundaries} with boundaries from ${dbPath}`)
  if (withBoundaries === 0) throw new Error(`no file has boundaries: is ${dbPath} an index of ${root}?`)

  const golden = readFileSync(path.join(root, 'evals/retrieval/golden.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as GoldenQuery)
  const labels = new Map<string, RelevantSpan[]>(golden.map((g) => [g.id, g.relevant.flatMap((l) => resolveLabel(l, readFileSync(path.join(root, l.file), 'utf8')))]))
  const queryVecs = await cache.embed(golden.map((g) => `${QUERY_INSTRUCTION_PREFIX}${g.query}`))
  const overFetch = Math.min(MAX_OVER_FETCH, Math.ceil(K * OVER_FETCH_FACTOR))

  const run = async (config: ChunkConfig): Promise<ConfigResult> => {
    const count = scaledCounter(realCount, config.tokens)
    const chunks: Chunk[] = files.flatMap((f) => chunkFile(f.abs, f.content, MAX_CHUNK_CHARS, config.overlap, config.boundaries ? f.boundaries : [], count))
    const t0 = performance.now()
    const vecs = await cache.embed(
      chunks.map((c) => c.text),
      (done, total) => {
        if (done % 640 === 0 || done === total) console.error(`  ${config.name}: embedded ${done}/${total} new chunks (${((performance.now() - t0) / 1000).toFixed(0)}s)`)
      },
    )
    cache.save()
    const scores = golden.map((g, qi): QueryScore => {
      const near = nearest(queryVecs[qi] ?? [], vecs, overFetch, DEFAULT_DISTANCE_THRESHOLD)
      const hits: SearchHit[] = near.map(({ index, distance }) => {
        const c = chunks[index] as Chunk
        return { filePath: c.filePath, startLine: c.startLine, endLine: c.endLine, kind: c.kind, distance, text: c.text }
      })
      const ranked = rerankHits(hits, g.query, K)
      const merged = mergeNearbyHits(ranked)
      const asRanked = (hs: SearchHit[]): { file: string; lineStart: number; lineEnd: number }[] => hs.map((h) => ({ file: h.filePath, lineStart: h.startLine, lineEnd: h.endLine }))
      const rel = labels.get(g.id) ?? []
      const rank = firstRelevantRank(asRanked(ranked), rel, root)
      return {
        id: g.id,
        split: splitOf(g.id),
        rr: reciprocalRank(rank, K),
        hit: hitAtK(rank, K),
        rrMerged: reciprocalRank(firstRelevantRank(asRanked(merged), rel, root), K),
        bytes: ranked.reduce((n, h) => n + Buffer.byteLength(h.text), 0),
      }
    })
    const r = { config, chunks: chunks.length, scores }
    console.error(`  ${config.name}: ${chunks.length} chunks, MRR@10 ${mean(scores.map((s) => s.rr)).toFixed(3)}, hit@10 ${mean(scores.map((s) => s.hit)).toFixed(3)}`)
    return r
  }

  // A/A: re-embed every query and a fixed sample of baseline chunks with the cache bypassed, and compare against the cached vectors.
  const baseline = await run(BASELINE)
  const sampleChunks = files.flatMap((f) => chunkFile(f.abs, f.content, MAX_CHUNK_CHARS, BASELINE.overlap, f.boundaries, realCount)).filter((_, i) => i % 25 === 0)
  const aaTexts = [...golden.map((g) => `${QUERY_INSTRUCTION_PREFIX}${g.query}`), ...sampleChunks.map((c) => c.text)]
  const fresh = await embedTexts(aaTexts)
  const cached = await cache.embed(aaTexts)
  let aaMaxDiff = 0
  fresh.forEach((v, i) => v.forEach((x, j) => (aaMaxDiff = Math.max(aaMaxDiff, Math.abs(x - (cached[i]?.[j] ?? 0))))))
  console.error(`A/A: ${aaTexts.length} texts re-embedded, largest component difference ${aaMaxDiff}`)

  const results: ConfigResult[] = [baseline]
  const compare = (a: ConfigResult, b: ConfigResult, split: 'train' | 'test'): Interval => {
    const pick = (r: ConfigResult): number[] => r.scores.filter((s) => s.split === split).map((s) => s.rr)
    return pairedBootstrapDelta(pick(a), pick(b))
  }
  const decisions: { stage: string; candidate: string; incumbent: string; train: Interval; test: Interval; verdict: Verdict }[] = []
  let incumbent = baseline
  const stage = async (label: string, candidates: ChunkConfig[]): Promise<void> => {
    const start = incumbent
    let best: { r: ConfigResult; train: Interval } | null = null
    for (const c of candidates) {
      const r = await run(c)
      results.push(r)
      const train = compare(start, r, 'train')
      const test = compare(start, r, 'test')
      const verdict = decide(train, test)
      decisions.push({ stage: label, candidate: c.name, incumbent: start.config.name, train, test, verdict })
      console.error(`  ${label} ${c.name} vs ${start.config.name}: ${verdict.accept ? 'ACCEPT' : 'reject'} (${verdict.reason})`)
      if (verdict.accept && (best === null || train.mean > best.train.mean)) best = { r, train }
    }
    if (best !== null) incumbent = best.r
  }

  await stage('token budget', [128, 256, 384].map((tokens) => ({ name: `tokens-${tokens}`, tokens, overlap: 200, boundaries: true })))
  const t = incumbent.config.tokens
  await stage('overlap', [0, 400].map((overlap) => ({ name: `tokens-${t}-overlap-${overlap}`, tokens: t, overlap, boundaries: true })))
  const o = incumbent.config.overlap
  await stage('boundaries', [{ name: `tokens-${t}-overlap-${o}-no-boundaries`, tokens: t, overlap: o, boundaries: false }])

  const summary = results.map((r) => {
    const by = (split?: 'train' | 'test'): QueryScore[] => r.scores.filter((s) => split === undefined || s.split === split)
    return {
      config: r.config,
      chunks: r.chunks,
      mrr: bootstrapCI(by().map((s) => s.rr)),
      mrrTrain: bootstrapCI(by('train').map((s) => s.rr)),
      mrrTest: bootstrapCI(by('test').map((s) => s.rr)),
      hitAt10: bootstrapCI(by().map((s) => s.hit)),
      mrrMerged: bootstrapCI(by().map((s) => s.rrMerged)),
      bytesPerQuery: mean(by().map((s) => s.bytes)),
    }
  })
  const report = {
    model: DEFAULT_MODEL,
    corpusFiles: files.length,
    queries: { total: golden.length, train: golden.filter((g) => splitOf(g.id) === 'train').length, test: golden.filter((g) => splitOf(g.id) === 'test').length },
    aa: { texts: aaTexts.length, maxComponentDiff: aaMaxDiff },
    summary,
    decisions,
    recommendation: incumbent === baseline ? 'keep the production chunking: no candidate cleared the train interval with a positive test delta' : `adopt ${incumbent.config.name}`,
    perQuery: results.map((r) => ({ config: r.config.name, scores: r.scores })),
  }
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  for (const s of summary) console.log(`${s.config.name.padEnd(36)} chunks ${String(s.chunks).padStart(6)}  MRR@10 ${fmt(s.mrr)}  train ${s.mrrTrain.mean.toFixed(3)} test ${s.mrrTest.mean.toFixed(3)}  hit@10 ${s.hitAt10.mean.toFixed(3)}  merged MRR ${s.mrrMerged.mean.toFixed(3)}  bytes/query ${Math.round(s.bytesPerQuery)}`)
  console.log(`recommendation: ${report.recommendation}`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
