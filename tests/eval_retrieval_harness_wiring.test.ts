/** Wiring of scripts/eval-retrieval.ts around the binary it drives: it must exclude its own fixtures from the eval home's index before asking anything, refuse to score an arm that retrieved them, and report the weak-match line that home has configured rather than the shipped default. The stand-in binary's `semantic --json` payload is FORMAT-DERIVED from src/read_semantic.ts (`items[].filePath/startLine/endLine/distance`); its `config get --json` line is FORMAT-DERIVED from src/config_commands.ts (`get` spreads `{source}` beside `key`/`value`). The queries, distances and expected lines are HAND-DERIVED from the rows written here. The baseline files are FORMAT-DERIVED from evals/retrieval/gate.ts::toBaseline (arms[name] maps query id to rank), and the committed evals/retrieval/baseline.json is read as CAPTURE. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toBaseline } from '../evals/retrieval/gate.js'
import { splitOf } from '../evals/retrieval/metrics.js'
import { assertRan, baselineRanks, fixtureHits, pairWithBaseline, parseConfiguredNumber } from '../scripts/eval-retrieval.js'

const FAKE_BIN = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_TG_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'config') { process.stdout.write(JSON.stringify({ key: args[2], value: 0.6, source: 'global' }) + '\\n'); process.exit(0) }
if (args[0] === 'semantic' && process.env.FAKE_TG_CRASH === '1') { process.stderr.write('stand-in crashed on purpose\\n'); process.exit(2) }
if (args[0] === 'semantic') {
  const q = args[args.length - 1]
  const file = process.env.FAKE_TG_FIXTURE_HIT === '1' ? 'evals/retrieval/golden.jsonl' : 'doc.md'
  const distance = q.startsWith('absent') ? 0.95 : 0.4
  const payload = { source: 'embeddings', items: [{ filePath: file, name: null, kind: null, startLine: 1, endLine: 3, rank: 1, rrf: 0.01, retrieval: 'dense', distance, preview: '' }], truncated: false, totalCount: 1 }
  process.stdout.write(args.includes('-j') ? JSON.stringify(payload) + '\\n' : file + ':1-3\\n')
}
process.exit(0)
`

let root: string

/** One answerable and one absent query in each split, which is what the weak line needs to be fitted on train and scored on test (a class missing from a split leaves it unscored). Each query costs the harness two spawns of the stand-in binary (JSON, then text), so the least that exercises the wiring keeps the run short on a machine where a spawn is slow. */
function golden(): string {
  const want = new Map<string, number>()
  const lines: string[] = []
  for (let i = 0; lines.length < 4; i++) {
    const id = `q${i}`
    for (const kind of ['doc', 'absent'] as const) {
      const key = `${splitOf(id)}/${kind}`
      if ((want.get(key) ?? 0) >= 1) continue
      want.set(key, (want.get(key) ?? 0) + 1)
      lines.push(JSON.stringify({ id, query: `${kind === 'absent' ? 'absent' : 'alpha'} query ${i}`, kind, relevant: kind === 'absent' ? [] : [{ file: 'doc.md', heading: 'Alpha' }] }))
      break
    }
  }
  return `${lines.join('\n')}\n`
}

function runHarness(env: Record<string, string> = {}, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string; calls: string[][] } {
  const log = path.join(root, 'calls.jsonl')
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-retrieval.ts', '--home', path.join(root, 'home'), '--bin', path.join(root, 'fake-tg.mjs'), '--root', path.join(root, 'proj'), '--arms', 'semantic', ...extraArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FAKE_TG_LOG: log, ...env },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : []
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-eval-wiring-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(path.join(proj, 'evals', 'retrieval'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'doc.md'), '# Alpha\n\nalpha text\n')
  fs.writeFileSync(path.join(proj, 'evals', 'retrieval', 'golden.jsonl'), golden())
  fs.writeFileSync(path.join(root, 'fake-tg.mjs'), FAKE_BIN)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('eval-retrieval harness wiring', () => {
  it('excludes its fixtures before the first query and reports the configured weak line', () => {
    const r = runHarness()
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls[0]).toEqual(['project', 'exclude', path.join(root, 'proj', 'evals', 'retrieval')])
    expect(r.calls.slice(1).some((c) => c[0] === 'project'), 'excluded once, before anything else').toBe(false)
    expect(r.stdout).toContain('weak_distance 0.600 (configured) on test')
    expect(r.stdout).not.toContain('weak_distance 0.850 (configured)')
  }, 60_000)

  it('refuses to score an arm that retrieved its own fixtures', () => {
    const r = runHarness({ FAKE_TG_FIXTURE_HIT: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("semantic retrieved the eval's own fixtures")
    expect(r.stderr).toContain('evals/retrieval/golden.jsonl')
    expect(r.stdout).not.toContain('weak_distance')
  }, 60_000)
})

describe('eval-retrieval crash', () => {
  it('stops with a nonzero exit naming the command and its stderr when an arm exits 2, and prints no scores (HAND-DERIVED: the stand-in exits 2 on purpose)', () => {
    const r = runHarness({ FAKE_TG_CRASH: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('token-goat semantic')
    expect(r.stderr).toContain('exited 2')
    expect(r.stderr).toContain('stand-in crashed on purpose')
    expect(r.stdout).not.toContain('weak_distance')
  }, 60_000)
})

describe('assertRan', () => {
  // HAND-DERIVED from the spawnSync return shape in the Node child_process docs: a timeout sets error (code ETIMEDOUT) with a null status and a signal, a kill sets only signal, a clean run sets status.
  const timedOut = Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' })

  it('names the command and the timeout when spawnSync reports ETIMEDOUT', () => {
    expect(() => assertRan({ error: timedOut, signal: 'SIGTERM', status: null }, ['semantic', 'q'])).toThrow(/token-goat semantic q timed out after 60000 ms/)
  })

  it('names the signal when the child was killed, even though allowFail would take any exit code', () => {
    expect(() => assertRan({ error: undefined, signal: 'SIGKILL', status: null }, ['answer', 'q'])).toThrow(/token-goat answer q was killed by SIGKILL/)
  })

  it('refuses a null status with no signal and a start failure, and lets any numeric exit code through', () => {
    expect(() => assertRan({ error: undefined, signal: null, status: null }, ['x'])).toThrow(/ended with no exit code/)
    expect(() => assertRan({ error: Object.assign(new Error('spawnSync nope ENOENT'), { code: 'ENOENT' }), signal: null, status: null }, ['x'])).toThrow(/could not run: spawnSync nope ENOENT/)
    for (const status of [0, 1, 2]) expect(() => assertRan({ error: undefined, signal: null, status }, ['x'])).not.toThrow()
  })
})

describe('pairWithBaseline', () => {
  const row = (id: string): { id: string } => ({ id })

  it('returns the current rows when both sides ask the same queries, accepting baseline ids that are absent-kind rows of the current split', () => {
    const now = [row('a'), row('b')]
    expect(pairWithBaseline('semantic', 'train', now, [...now, row('gap')], new Map([['a', 1], ['b', null], ['gap', null]]))).toEqual(now)
  })

  it('throws naming each current query the baseline lacks', () => {
    const all = [row('a'), row('b'), row('c')]
    expect(() => pairWithBaseline('semantic', 'test', all, all, new Map([['a', 1]]))).toThrow(/arm "semantic" split test does not pair.*2 queries of this run are missing from the baseline \(b, c\)/)
  })

  it('throws naming each baseline query this run did not ask', () => {
    expect(() => pairWithBaseline('semantic', 'train', [row('a')], [row('a')], new Map([['a', 1], ['old1', 2], ['old2', null]]))).toThrow(/2 baseline queries were not asked this run \(old1, old2\)/)
  })
})

describe('eval-retrieval --baseline', () => {
  const goldenIds =(): string[] => golden().trim().split('\n').map((l) => (JSON.parse(l) as { id: string }).id)
  const writeBaseline = (value: unknown): string => {
    const file = path.join(root, 'baseline.json')
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }

  it('compares against a baseline in the shape toBaseline writes and prints the paired delta its ranks give for both splits', () => {
    const rows = goldenIds().map((id) => ({ id, kind: 'doc', rank: 2 }))
    const file = writeBaseline(toBaseline({ semantic: rows }, 0))
    const r = runHarness({}, ['--baseline', file])
    expect(r.status, r.stderr).toBe(0)
    // HAND-DERIVED: the stand-in ranks the one answerable query of each split first (reciprocal rank 1) and the baseline recorded rank 2 (0.5), so each split's one paired query moves by exactly +0.500.
    expect(r.stdout).toMatch(/^delta semantic\s+train\s+MRR@10 \+0\.500 \[0\.500, 0\.500\]\s{2}improved$/m)
    expect(r.stdout).toMatch(/^delta semantic\s+test\s+MRR@10 \+0\.500 \[0\.500, 0\.500\]\s{2}improved$/m)
  }, 60_000)

  it('exits nonzero naming the id when the baseline lacks an answerable query, and when it ranks one the run never asked', () => {
    const answerable = golden().trim().split('\n').map((l) => JSON.parse(l) as { id: string; kind: string }).filter((g) => g.kind !== 'absent').map((g) => g.id)
    const allRows = goldenIds().map((id) => ({ id, kind: 'doc', rank: 2 }))
    const dropped = answerable[0]
    const lacking = runHarness({}, ['--baseline', writeBaseline(toBaseline({ semantic: allRows.filter((x) => x.id !== dropped) }, 0))])
    expect(lacking.status).not.toBe(0)
    expect(lacking.stderr).toContain(`missing from the baseline (${dropped})`)
    const extra = runHarness({}, ['--baseline', writeBaseline(toBaseline({ semantic: [...allRows, { id: 'zz-never-asked', kind: 'doc', rank: 1 }] }, 0))])
    expect(extra.status).not.toBe(0)
    expect(extra.stderr).toContain('baseline queries were not asked this run (zz-never-asked)')
  }, 60_000)

  it('exits 1 naming the arm when a baseline arm is neither a row list nor a rank map', () => {
    const r = runHarness({}, ['--baseline', writeBaseline({ schema: 1, distractors: 0, arms: { semantic: 'oops' } })])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('baseline arm "semantic" is neither a list of report rows nor a map of query id to rank')
  }, 60_000)
})

describe('baselineRanks', () => {
  const ids = ['id-a', 'id-b', 'id-c', 'id-d', 'id-e', 'id-f']

  it('keeps only the asked split from a list of report rows', () => {
    const rows = ids.map((id) => ({ id, split: splitOf(id), kind: 'doc', rank: 3 }))
    for (const split of ['train', 'test'] as const) {
      expect([...baselineRanks(rows, split, 'a').keys()]).toEqual(ids.filter((id) => splitOf(id) === split))
    }
  })

  it('keeps only the asked split from a rank map, deriving the split from the id', () => {
    const arm = Object.fromEntries(ids.map((id, i) => [id, i % 2 === 0 ? null : i]))
    for (const split of ['train', 'test'] as const) {
      const got = baselineRanks(arm, split, 'a')
      expect([...got.keys()]).toEqual(ids.filter((id) => splitOf(id) === split))
      for (const [id, rank] of got) expect(rank).toBe(arm[id])
    }
  })

  it('reads every arm of the committed baseline.json (CAPTURE: the file as committed)', () => {
    const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals', 'retrieval', 'baseline.json'), 'utf8')) as { arms: Record<string, Record<string, number | null>> }
    for (const [name, arm] of Object.entries(base.arms)) {
      const n = baselineRanks(arm, 'train', name).size + baselineRanks(arm, 'test', name).size
      expect(n, name).toBe(Object.keys(arm).length)
    }
  })

  it('throws on a row that is not a report row, a non-rank value, and a non-container', () => {
    expect(() => baselineRanks([{ id: 'x', rank: 1 }], 'train', 'a')).toThrow(/not a report row/)
    expect(() => baselineRanks({ x: '1' }, 'train', 'a')).toThrow(/not a rank/)
    expect(() => baselineRanks(7, 'train', 'a')).toThrow(/neither a list of report rows nor a map/)
    expect(() => baselineRanks(null, 'train', 'a')).toThrow(/neither a list of report rows nor a map/)
  })
})

describe('fixtureHits', () => {
  it('names every top-K file inside evals/retrieval and nothing outside it', () => {
    const rows = [
      { id: 'a', topFiles: ['src/x.ts', 'evals/retrieval/golden.jsonl'] },
      { id: 'b', topFiles: ['evals/retrieval.md', 'evals/other/golden.jsonl'] },
      { id: 'c', topFiles: ['evals/retrieval/answer.jsonl', 'evals/retrieval/labels.ts'] },
    ]
    expect(fixtureHits(rows)).toEqual(['a: evals/retrieval/golden.jsonl', 'c: evals/retrieval/answer.jsonl', 'c: evals/retrieval/labels.ts'])
  })
})

describe('parseConfiguredNumber', () => {
  it('returns the effective value config get printed', () => {
    expect(parseConfiguredNumber('{"key":"semantic.weak_distance","value":0.72,"source":"project"}\n', 'semantic.weak_distance')).toBe(0.72)
  })

  it('throws on another key, a non-number, or a non-finite value', () => {
    expect(() => parseConfiguredNumber('{"key":"semantic.max_distance","value":0.9}', 'semantic.weak_distance')).toThrow(/printed no number/)
    expect(() => parseConfiguredNumber('{"key":"semantic.weak_distance","value":"0.9"}', 'semantic.weak_distance')).toThrow(/printed no number/)
    expect(() => parseConfiguredNumber('{"key":"semantic.weak_distance","value":null}', 'semantic.weak_distance')).toThrow(/printed no number/)
  })
})
