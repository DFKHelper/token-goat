/** Golden retrieval eval: runs the real `search`, `semantic` and `answer` commands over the labelled queries in evals/retrieval and reports hit@k, MRR@10 and bytes per correct hit, each with a bootstrap interval, separately for the train and test splits. Usage: npx tsx scripts/eval-retrieval.ts --home <dir> [--bin token-goat] [--root .] [--reindex] [--out report.json] [--baseline old.json] [--arms fused,semantic,...] [--distractors N] [--limit N] `--home` is required and every child runs with HOME, USERPROFILE, TOKEN_GOAT_HOME, LOCALAPPDATA, APPDATA and XDG_DATA_HOME pointed inside it, because `answer` and the search commands write to the savings ledger and an eval run must never land in the user's real one. `--reindex` builds that home's index first. `--baseline` takes an earlier report and prints the paired per-query delta for each arm, which is how a change is judged: keep it only when both splits improve past the interval. Queries of kind `absent` have no answer in the repo. They are left out of every hit-rate line and scored instead on whether each arm abstains: `search` by returning nothing, `semantic` by flagging its closest match as weak. For `semantic` the report also fits the weak-match line on the train split and scores it on the test split beside the line the eval home has configured, read back with `config get` rather than assumed to be the default. `--distractors N` swaps the repo for a scratch project under `<home>/corpus` holding only the files the golden set labels plus N seeded distractor files (placeholder stubs, near-duplicate names, boilerplate; see evals/retrieval/distractors.ts), so `--distractors 0` is the control and any N is the same labelled files drowned in noise; the `answer` arm is skipped there because its expectations are repo-wide. Every run excludes evals/retrieval from that home's index and refuses to score a hit inside it, because the golden file holds every query's own text. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { summarizeDistances } from '../src/semantic_distances.js'
import type { DistanceRow } from '../evals/retrieval/calibration.js'
import { DISTRACTOR_SEED, generateDistractors } from '../evals/retrieval/distractors.js'
import { resolveLabel, type GoldenLabel } from '../evals/retrieval/labels.js'
import { num, pct, qualityLines, weakFitLines } from '../evals/retrieval/quality.js'
import {
  bootstrapCI,
  bytesPerCorrectHit,
  correctInTopK,
  firstRelevantRank,
  hitAtK,
  normalizePath,
  pairedBootstrapDelta,
  reciprocalRank,
  splitOf,
  type Interval,
  type RankedHit,
  type RelevantSpan,
} from '../evals/retrieval/metrics.js'

const K = 10

/** The eval's own fixtures. The golden file holds every query verbatim, so an index that includes it lets the text channel find each query in its own label row. `index .` skips `.jsonl`, but the worker's dirty queue does not. */
export const FIXTURE_DIR = 'evals/retrieval'

/** Every top-K hit inside FIXTURE_DIR, as `id: file`. Rows carry paths through normalizePath, so they are lowercase and root-relative. */
export function fixtureHits(rows: readonly { readonly id: string; readonly topFiles: readonly string[] }[]): string[] {
  return rows.flatMap((r) => r.topFiles.filter((f) => f.startsWith(`${FIXTURE_DIR}/`)).map((f) => `${r.id}: ${f}`))
}

/** The value `config get <key> --json` printed, which is the effective setting for that home and project rather than the shipped default. */
export function parseConfiguredNumber(stdout: string, key: string): number {
  const j = JSON.parse(stdout) as { key?: unknown; value?: unknown }
  if (j.key !== key || typeof j.value !== 'number' || !Number.isFinite(j.value)) throw new Error(`config get ${key} printed no number: ${stdout.slice(0, 200)}`)
  return j.value
}

interface GoldenQuery {
  readonly id: string
  readonly query: string
  readonly kind: 'identifier' | 'paraphrase' | 'doc' | 'absent'
  readonly relevant: readonly GoldenLabel[]
  readonly why_hard?: string
}

interface AnswerQuery {
  readonly id: string
  readonly question: string
  readonly route: string
  readonly expectFiles: readonly string[]
  readonly why_hard?: string
}

/** One arm is one way of asking: `search` fused over every channel, `search` restricted to one channel, or `semantic`. */
interface Arm {
  readonly name: string
  readonly json: (q: string) => string[]
  readonly text: (q: string) => string[]
  readonly parse: (stdout: string) => Parsed
}

/** One arm's answer: its ranked hits, whether it abstained, and the closest dense distance behind that call (null when the arm reports none). */
interface Parsed {
  readonly hits: RankedHit[]
  readonly abstained: boolean
  readonly closest: number | null
}

interface SearchJson {
  results?: { filePath: string; lineStart?: number; lineEnd?: number }[]
}
interface SemanticJson {
  items?: { filePath: string; startLine?: number; endLine?: number; distance?: number | null }[]
  lowConfidence?: { closestDistance: number }
}

/** `search` has no confidence signal, so it abstains only by returning nothing. */
function parseSearch(s: string): Parsed {
  const hits = ((JSON.parse(s) as SearchJson).results ?? []).map((r) => ({ file: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd }))
  return { hits, abstained: hits.length === 0, closest: null }
}

/** `semantic` abstains when it flags its closest match as weak, and also when no dense match came back at all, which is what `abstainsAt` scores. The closest distance is the flagged one when present, else the smallest a dense item carries; lexical items carry null. */
export function parseSemantic(s: string): Parsed {
  const j = JSON.parse(s) as SemanticJson
  const items = j.items ?? []
  const dense = items.flatMap((r) => (typeof r.distance === 'number' ? [r.distance] : []))
  const closest = j.lowConfidence?.closestDistance ?? (dense.length === 0 ? null : Math.min(...dense))
  return { hits: items.map((r) => ({ file: r.filePath, lineStart: r.startLine, lineEnd: r.endLine })), abstained: j.lowConfidence !== undefined || closest === null, closest }
}

/** The count `--distractors` asked for, null when the flag is absent. Anything that is not a whole number of zero or more is a typo to stop on, not a corpus size to guess at. */
export function parseDistractorCount(raw: string | undefined): number | null {
  if (raw === undefined) return null
  if (!/^[0-9]+$/.test(raw)) throw new Error(`--distractors takes a whole number of files, got ${JSON.stringify(raw)}`)
  return Number(raw)
}

/** Builds the distractor arm's project: the labelled files copied from `repoRoot` at the same relative paths, `count` seeded distractors beside them, committed to a fresh git repo so `index .` tracks them. Replaces whatever `dest` held; `dest` lives under the eval home and holds no links. */
export function materializeCorpus(repoRoot: string, golden: readonly GoldenQuery[], dest: string, count: number): void {
  rmSync(dest, { recursive: true, force: true })
  const labelled = [...new Set(golden.flatMap((g) => g.relevant.map((l) => l.file)))]
  const write = (rel: string, from: string | null, content = ''): void => {
    const to = path.join(dest, rel)
    mkdirSync(path.dirname(to), { recursive: true })
    if (from === null) writeFileSync(to, content)
    else copyFileSync(from, to)
  }
  for (const f of labelled) write(f, path.join(repoRoot, f))
  const names = [...new Set(golden.flatMap((g) => g.relevant.flatMap((l) => (l.symbol === undefined ? [] : [l.symbol]))))]
  for (const d of generateDistractors(count, names, DISTRACTOR_SEED)) write(d.path, null, d.content)
  const ident = ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false']
  for (const args of [['init', '-q'], ['add', '-A'], [...ident, 'commit', '-q', '-m', 'eval corpus']]) {
    const g = spawnSync('git', args, { cwd: dest, encoding: 'utf8', windowsHide: true })
    if (g.error !== undefined || g.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dest}: ${g.error?.message ?? g.stderr}`)
  }
}

/** How many hits each arm asks for. K stays the scoring cutoff; a deeper list only lets a rank past K be recorded, which is how the hit-rate-versus-depth table is made (`--limit`). */
let listDepth = K

const searchArm = (name: string, channel?: string): Arm => {
  const base = (q: string): string[] => ['search', '-l', String(listDepth), ...(channel !== undefined ? ['-c', channel] : []), q]
  return { name, json: (q) => [...base(q), '-j'], text: base, parse: parseSearch }
}

export const ARMS: readonly Arm[] = [
  searchArm('fused'),
  searchArm('symbol', 'symbol'),
  searchArm('heading', 'heading'),
  searchArm('text', 'text'),
  searchArm('search-semantic', 'semantic'),
  { name: 'semantic', json: (q) => ['semantic', '-l', String(listDepth), '-j', q], text: (q) => ['semantic', '-l', String(listDepth), q], parse: parseSemantic },
]

const REFUSAL = 'cannot answer deterministically:'
const PATH_TOKEN = /(?:^|[\s('"`])((?:[a-zA-Z]:)?\/?(?:\.{1,2}\/|[\w@.-]+\/)*[\w.-]+\.(?:[mc]?[jt]sx?|md|json))(?::\d+)?/g

/** Grades one `answer` run from its streams. The first stdout line is `via: token-goat <command> ...`, and the word after `token-goat` is the route. A refusal prints nothing on stdout and `cannot answer deterministically: ...` on stderr. Anything else (a crash, an empty answer) is `error`, never `refused`, so a broken router cannot score on the refusal cases. The delegates print files in three shapes (`name  src/x.ts:12`, an indented `src/x.ts` under `imported by:`, and an import specifier such as `./x.js`), so every path-shaped token after the `via:` line is collected. */
export function parseAnswer(stdout: string, stderr = ''): { route: string; files: string[] } {
  const lines = stdout.split(/\r?\n/)
  const via = /^via: token-goat (\S+)/.exec(lines[0] ?? '')
  if (via === null) return { route: stderr.includes(REFUSAL) && stdout.trim() === '' ? 'refused' : 'error', files: [] }
  const files = new Set<string>()
  for (const l of lines.slice(1)) for (const m of l.replaceAll('\\', '/').matchAll(PATH_TOKEN)) if (m[1] !== undefined) files.add(m[1])
  return { route: via[1] ?? '', files: [...files] }
}

/** Whether a file `answer` printed is `expected` (repo-relative). An import specifier is written relative to the importing file and with the emitted `.js` extension, so a specifier matches on its trailing path segments with `.js` read as `.ts`; a printed repo path must match whole. */
export function answerFileMatches(expected: string, printed: string, root = ''): boolean {
  const want = normalizePath(expected, root)
  const got = normalizePath(printed, root)
  if (got === want) return true
  if (!/^\.{1,2}\//.test(printed.replaceAll('\\', '/'))) return false
  const tail = got.replace(/^(?:\.{1,2}\/)+/, '').replace(/\.([mc]?)js(x?)$/, '.$1ts$2')
  return want === tail || want.endsWith(`/${tail}`)
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const h = path.resolve(home)
  const dirs = { TOKEN_GOAT_HOME: path.join(h, 'tg'), LOCALAPPDATA: path.join(h, 'la'), APPDATA: path.join(h, 'ad'), XDG_DATA_HOME: path.join(h, 'xdg') }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  return { ...process.env, ...dirs, HOME: h, USERPROFILE: h, TOKEN_GOAT_BASH_COMPRESS: '0' }
}

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  readonly ms: number
}

/** Runs one command. A nonzero exit throws unless `allowFail` is set, which `answer` needs because a refusal is a graded outcome there, printed to stderr with exit 1, and the arms need because `semantic` exits 1 when nothing matched. A `.mjs` bundle runs under this Node directly. Any other name on Windows is an npm `.cmd` shim, which only a shell can start, and Node deprecates handing an argument array to a shell (DEP0190), so the shell gets one quoted command line instead. */
function runner(bin: string, cwd: string, env: NodeJS.ProcessEnv): (args: string[], allowFail?: boolean) => Run {
  const opts = { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true } as const
  const start = (args: string[]): SpawnSyncReturns<string> => {
    if (bin.endsWith('.mjs')) return spawnSync(process.execPath, [bin, ...args], opts)
    if (process.platform === 'win32') return spawnSync([bin, ...args].map(cmdQuote).join(' '), { ...opts, shell: true })
    return spawnSync(bin, args, opts)
  }
  return (args, allowFail = false) => {
    const t0 = performance.now()
    const r = start(args)
    const ms = performance.now() - t0
    if (r.error !== undefined) throw r.error
    if (r.status !== 0 && !allowFail) throw new Error(`token-goat ${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 500)}`)
    return { stdout: r.stdout, stderr: r.stderr, status: r.status, ms }
  }
}

/** Runs one query through an arm, JSON then text. Exit 1 is accepted only when the JSON parses to no hits, which is how `semantic` reports an empty result; any other failure, or JSON that does not parse, is a crash and stops the run rather than scoring as a miss. */
function askArm(exec: ReturnType<typeof runner>, arm: Arm, query: string): { parsed: Parsed; text: Run } {
  const j = exec(arm.json(query), true)
  let parsed: Parsed | undefined
  try {
    parsed = arm.parse(j.stdout)
  } catch {
    parsed = undefined
  }
  const fail = (r: Run): boolean => r.status !== 0 && !(r.status === 1 && parsed?.hits.length === 0)
  if (parsed === undefined || fail(j)) throw new Error(`token-goat ${arm.json(query).join(' ')} exited ${j.status}: ${j.stderr.slice(0, 500)}`)
  const text = exec(arm.text(query), true)
  if (fail(text)) throw new Error(`token-goat ${arm.text(query).join(' ')} exited ${text.status}: ${text.stderr.slice(0, 500)}`)
  return { parsed, text }
}

/** Quote one word for cmd.exe. A query is plain words, so double quotes are enough once any inside it are dropped. */
const cmdQuote = (s: string): string => `"${s.replaceAll('"', '')}"`

interface QueryResult {
  readonly id: string
  readonly split: 'train' | 'test'
  readonly kind: string
  readonly rank: number | null
  readonly correct: number
  readonly bytes: number
  readonly ms: number
  readonly top: string[]
  readonly abstained: boolean
  readonly closest: number | null
  readonly topFiles: string[]
  readonly labelFiles: string[]
}

interface ArmSummary {
  readonly n: number
  readonly hit1: Interval
  readonly hit5: Interval
  readonly hit10: Interval
  readonly mrr10: Interval
  readonly bytesPerCorrectHit: number | null
  readonly medianMs: number
}

function summarize(rows: readonly QueryResult[]): ArmSummary {
  const ranks = rows.map((r) => r.rank)
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  return {
    n: rows.length,
    hit1: bootstrapCI(ranks.map((r) => hitAtK(r, 1))),
    hit5: bootstrapCI(ranks.map((r) => hitAtK(r, 5))),
    hit10: bootstrapCI(ranks.map((r) => hitAtK(r, K))),
    mrr10: bootstrapCI(ranks.map((r) => reciprocalRank(r, K))),
    bytesPerCorrectHit: bytesPerCorrectHit(
      rows.reduce((s, r) => s + r.bytes, 0),
      rows.reduce((s, r) => s + r.correct, 0),
    ),
    medianMs: ms[Math.floor(ms.length / 2)] ?? Number.NaN,
  }
}

/** How far `semantic`'s closest match sits for answerable and for absent queries, in the bands `token-goat semantic --distances` prints, then the weak-match line fitted on train and scored on test. The closest distance is read from the top results, so a dense hit that fusion pushed below them reads slightly further than it was. */
function distanceLines(rows: readonly QueryResult[], indent: string, weak: number): string[] {
  const out: string[] = []
  for (const [label, absent] of [['answerable', false], ['absent', true]] as const) {
    const s = summarizeDistances(rows.filter((r) => (r.kind === 'absent') === absent).map((r) => ({ closest_distance: r.closest })), weak)
    out.push(`${indent}closest distance, ${label.padEnd(10)} ${s.bands.map((b) => `${b.range} ${b.count}`).join('  ')}`)
  }
  const distanceRows = (split: string): DistanceRow[] => rows.filter((r) => r.split === split).map((r) => ({ absent: r.kind === 'absent', closest: r.closest }))
  out.push(...weakFitLines(distanceRows('train'), distanceRows('test'), weak, indent))
  return out
}

interface Report {
  readonly arms: Record<string, QueryResult[]>
  readonly answer: { id: string; split: string; route: string; routeOk: boolean; fileRecall: number }[]
}

function main(): void {
  const home = arg('home')
  if (home === undefined) {
    process.stderr.write('eval-retrieval: --home <dir> is required; the commands write to the savings ledger and must not touch your real one.\n')
    process.exit(2)
  }
  const repoRoot = path.resolve(arg('root') ?? '.')
  const bin = arg('bin') ?? 'token-goat'
  const golden = readJsonl<GoldenQuery>(path.join(repoRoot, FIXTURE_DIR, 'golden.jsonl'))
  const distractors = parseDistractorCount(arg('distractors'))
  const limitArg = arg('limit')
  if (limitArg !== undefined) {
    if (!/^[1-9][0-9]*$/.test(limitArg)) throw new Error(`--limit takes a whole number of hits, one or more, got ${JSON.stringify(limitArg)}`)
    listDepth = Math.max(K, Number(limitArg))
  }
  const root = distractors === null ? repoRoot : path.join(path.resolve(home), 'corpus')
  if (distractors !== null) materializeCorpus(repoRoot, golden, root, distractors)
  const env = isolatedEnv(home)
  const exec = runner(bin, root, env)
  const armFilter = arg('arms')?.split(',')
  const arms = ARMS.filter((a) => armFilter === undefined || armFilter.includes(a.name))

  // Before the reindex so `index .` never reads the fixtures, and on every run so rows the worker indexed earlier are removed too.
  if (distractors === null) exec(['project', 'exclude', path.join(root, FIXTURE_DIR)])
  if (process.argv.includes('--reindex')) exec(['index', '.', '--embed'])

  const labels = new Map<string, RelevantSpan[]>(golden.map((g) => [g.id, g.relevant.flatMap((l) => resolveLabel(l, readFileSync(path.join(root, l.file), 'utf8')))]))

  const report: Report = { arms: {}, answer: [] }
  for (const arm of arms) {
    const rows: QueryResult[] = []
    for (const g of golden) {
      const rel = labels.get(g.id) ?? []
      const { parsed, text: t } = askArm(exec, arm, g.query)
      const hits = parsed.hits
      rows.push({
        id: g.id,
        split: splitOf(g.id),
        kind: g.kind,
        rank: firstRelevantRank(hits, rel, root),
        correct: correctInTopK(hits, rel, K, root),
        bytes: Buffer.byteLength(t.stdout, 'utf8'),
        ms: t.ms,
        top: hits.slice(0, 3).map((h) => `${normalizePath(h.file, root)}:${h.lineStart ?? ''}`),
        abstained: parsed.abstained,
        closest: parsed.closest,
        topFiles: hits.slice(0, K).map((h) => normalizePath(h.file, root)),
        labelFiles: [...new Set(g.relevant.map((l) => normalizePath(l.file, root)))],
      })
    }
    const selfHits = fixtureHits(rows)
    if (selfHits.length > 0) {
      process.stderr.write(`eval-retrieval: ${arm.name} retrieved the eval's own fixtures, so its scores would count queries finding their own text; refusing to score: ${selfHits.slice(0, 5).join(', ')}\n`)
      process.exit(1)
    }
    report.arms[arm.name] = rows
    process.stderr.write(`eval-retrieval: ${arm.name} done\n`)
  }

  if (distractors === null && (armFilter === undefined || armFilter.includes('answer'))) {
    for (const a of readJsonl<AnswerQuery>(path.join(repoRoot, FIXTURE_DIR, 'answer.jsonl'))) {
      const r = exec(['answer', a.question], true)
      const got = parseAnswer(r.stdout, r.stderr)
      const found = a.expectFiles.filter((f) => got.files.some((p) => answerFileMatches(f, p, root))).length
      report.answer.push({ id: a.id, split: splitOf(a.id), route: got.route, routeOk: got.route === a.route, fileRecall: a.expectFiles.length === 0 ? 1 : found / a.expectFiles.length })
    }
  }

  const out: string[] = []
  const indent = ''.padEnd(17)
  for (const [name, all] of Object.entries(report.arms)) {
    const rows = all.filter((r) => r.kind !== 'absent')
    for (const split of ['train', 'test'] as const) {
      const s = summarize(rows.filter((r) => r.split === split))
      out.push(`${name.padEnd(16)} ${split.padEnd(5)} n=${String(s.n).padStart(2)}  hit@1 ${pct(s.hit1)}  hit@5 ${pct(s.hit5)}  hit@10 ${pct(s.hit10)}  MRR@10 ${num(s.mrr10)}  B/hit ${s.bytesPerCorrectHit === null ? '-' : Math.round(s.bytesPerCorrectHit)}  p50 ${Math.round(s.medianMs)}ms`)
    }
    for (const kind of ['identifier', 'paraphrase', 'doc']) {
      const s = summarize(rows.filter((r) => r.kind === kind))
      if (s.n > 0) out.push(`${''.padEnd(16)} ${kind.padEnd(10)} n=${String(s.n).padStart(2)}  hit@10 ${pct(s.hit10)}  MRR@10 ${num(s.mrr10)}`)
    }
    out.push(...qualityLines(all.map((r) => ({ ...r, absent: r.kind === 'absent' })), indent))
    if (name === 'semantic') out.push(...distanceLines(all, indent, parseConfiguredNumber(exec(['config', 'get', 'semantic.weak_distance', '--json']).stdout, 'semantic.weak_distance')))
  }
  for (const split of ['train', 'test']) {
    const rows = report.answer.filter((r) => r.split === split)
    if (rows.length > 0) out.push(`answer           ${split.padEnd(5)} n=${String(rows.length).padStart(2)}  route ${pct(bootstrapCI(rows.map((r) => (r.routeOk ? 1 : 0))))}  file recall ${pct(bootstrapCI(rows.map((r) => r.fileRecall)))}`)
  }
  for (const r of report.answer.filter((x) => !x.routeOk)) out.push(`  answer miss ${r.id}: routed to ${r.route}`)

  const baselinePath = arg('baseline')
  if (baselinePath !== undefined) {
    const base = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report
    for (const [name, rows] of Object.entries(report.arms)) {
      const old = base.arms[name]
      if (old === undefined) continue
      for (const split of ['train', 'test'] as const) {
        const now = rows.filter((r) => r.split === split && r.kind !== 'absent')
        const before = new Map(old.filter((r) => r.split === split).map((r) => [r.id, r.rank]))
        const paired = now.filter((r) => before.has(r.id))
        const d = pairedBootstrapDelta(
          paired.map((r) => reciprocalRank(before.get(r.id) ?? null, K)),
          paired.map((r) => reciprocalRank(r.rank, K)),
        )
        out.push(`delta ${name.padEnd(16)} ${split.padEnd(5)} MRR@10 ${d.mean >= 0 ? '+' : ''}${num(d)}${d.lo > 0 ? '  improved' : d.hi < 0 ? '  REGRESSED' : ''}`)
      }
    }
  }

  process.stdout.write(`${out.join('\n')}\n`)
  const outPath = arg('out')
  if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main()
