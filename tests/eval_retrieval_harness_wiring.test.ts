/** Wiring of scripts/eval-retrieval.ts around the binary it drives: it must exclude its own fixtures from the eval home's index before asking anything, refuse to score an arm that retrieved them, and report the weak-match line that home has configured rather than the shipped default. The stand-in binary's `semantic --json` payload is FORMAT-DERIVED from src/read_semantic.ts (`items[].filePath/startLine/endLine/distance`); its `config get --json` line is FORMAT-DERIVED from src/config_commands.ts (`get` spreads `{source}` beside `key`/`value`). The queries, distances and expected lines are HAND-DERIVED from the rows written here. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { splitOf } from '../evals/retrieval/metrics.js'
import { fixtureHits, parseConfiguredNumber } from '../scripts/eval-retrieval.js'

const FAKE_BIN = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_TG_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'config') { process.stdout.write(JSON.stringify({ key: args[2], value: 0.6, source: 'global' }) + '\\n'); process.exit(0) }
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

/** Two answerable and two absent queries in each split, so the weak line can be fitted on train and scored on test. */
function golden(): string {
  const want = new Map<string, number>()
  const lines: string[] = []
  for (let i = 0; lines.length < 8; i++) {
    const id = `q${i}`
    for (const kind of ['doc', 'absent'] as const) {
      const key = `${splitOf(id)}/${kind}`
      if ((want.get(key) ?? 0) >= 2) continue
      want.set(key, (want.get(key) ?? 0) + 1)
      lines.push(JSON.stringify({ id, query: `${kind === 'absent' ? 'absent' : 'alpha'} query ${i}`, kind, relevant: kind === 'absent' ? [] : [{ file: 'doc.md', heading: 'Alpha' }] }))
      break
    }
  }
  return `${lines.join('\n')}\n`
}

function runHarness(env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; calls: string[][] } {
  const log = path.join(root, 'calls.jsonl')
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-retrieval.ts', '--home', path.join(root, 'home'), '--bin', path.join(root, 'fake-tg.mjs'), '--root', path.join(root, 'proj'), '--arms', 'semantic'], {
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
