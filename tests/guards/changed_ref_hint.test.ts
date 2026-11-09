/** Guard against two regressions in `token-goat changed`: (a) `.command('changed')` was registered with no positional argument spec, so Commander silently dropped a `changed <ref>` invocation (the exact form README documents) — the run always fell through to the `HEAD~5` default with no error and no signal the argument was ignored. (b) the `HEAD~5` default fails on any repo with fewer than 6 commits (a fresh checkout, a shallow CI clone, a new project) with raw git stderr that names no working alternative, even though `--since` exists and would fix it. These run the real built bundle against real git fixtures so a severed positional-argument wire, or a hardcoded/non-resolving hint, cannot pass by accident (a mocked `runGit` call sequence could satisfy either without exercising the actual CLI argument plumbing). */
// tg-no-regex-preload: spawns the built bundle or runs a subprocess and never calls the parser in this process

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE, type RunResult } from '../helpers/bundle.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

// A process start costs seconds on a slow or busy machine, so the work is cut two ways: each fixture repo is three git starts however many commits it holds, and every bundle run a row needs is started together with the others in beforeAll, so the file waits for the longest chain of starts and not for their sum. Each run ends on its own timeout (execFile kills the child).
const RUN_TIMEOUT_MS = 50000

function run(file: string, args: string[], opts: { cwd?: string; input?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd: opts.cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code
      resolve({ status: error === null ? 0 : typeof code === 'number' ? code : null, stdout, stderr: error !== null && typeof code !== 'number' ? `${stderr}\n${error.message}` : stderr })
    })
    // A git that exits before reading its stdin fails the pending write with EPIPE; the exit status already reports that.
    child.stdin?.on('error', () => undefined)
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

function git(cwd: string, args: string[], input?: string): Promise<RunResult> {
  return run('git', args, { cwd, ...(input !== undefined ? { input } : {}) }).then((r) => {
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${String(r.status)}): ${r.stderr}`)
    return r
  })
}

function bundle(args: string[], cwd: string): Promise<RunResult> {
  return run(process.execPath, [BUNDLE, ...args], { cwd })
}

function fileName(i: number): string {
  return `f${i}.ts`
}

function fileContent(i: number): string {
  return `export function f${i}(): number {\n  return ${i}\n}\n`
}

/** One `git fast-import` stream recording every commit in a single process start: each commit adds one file. */
function fastImportStream(commitCount: number): string {
  const lines: string[] = []
  for (let i = 1; i <= commitCount; i++) {
    const message = `commit ${i}`
    const content = fileContent(i)
    lines.push('commit refs/heads/main', `committer t <t@t.t> ${1700000000 + i} +0000`, `data ${Buffer.byteLength(message)}`, message, `M 100644 inline ${fileName(i)}`, `data ${Buffer.byteLength(content)}`, content)
  }
  return `${lines.join('\n')}\n`
}

/** A git repo with the given number of commits, each touching one file: init, one fast-import for the whole history, and a mixed reset that fills the index to match the files written here, so `git diff <ref>` sees a clean work tree. */
async function buildRepo(commitCount: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-changed-hint-'))
  tempDirs.push(dir)
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['fast-import', '--quiet'], fastImportStream(commitCount))
  for (let i = 1; i <= commitCount; i++) fs.writeFileSync(path.join(dir, fileName(i)), fileContent(i))
  await git(dir, ['reset', '-q'])
  return dir
}

interface Fixture {
  readonly dir: string
  /** The bare `token-goat changed` run, which resolves the default HEAD~5. */
  readonly bare: RunResult
  /** `changed --since <ref>` with the ref the bare run's hint suggested, or null when it suggested none. */
  readonly follow: RunResult | null
  readonly suggestedRef: string | null
  /** The positional-ref runs, made in the 3-commit repo only. */
  readonly positional: Positional | null
}

async function buildFixture(commitCount: number): Promise<Fixture> {
  const dir = await buildRepo(commitCount)
  // The 3-commit repo also serves the positional rows, whose runs start beside the bare run.
  const positionalRuns = commitCount === 3 ? buildPositional(dir) : Promise.resolve(null)
  const bare = await bundle(['changed'], dir)
  const suggestedRef = /token-goat changed --since (\S+)/.exec(bare.stderr)?.[1] ?? null
  const follow = suggestedRef === null ? null : await bundle(['changed', '--since', suggestedRef], dir)
  return { dir, bare, follow, suggestedRef, positional: await positionalRuns }
}

interface Positional {
  readonly head1: RunResult
  readonly sinceA: RunResult
  readonly sinceB: RunResult
}

async function buildPositional(dir: string): Promise<Positional> {
  const [head1, sinceA, sinceB] = await Promise.all([
    bundle(['changed', 'HEAD~1'], dir),
    // HEAD~1 vs --since HEAD~2 -> --since wins -> 2 files changed (f2.ts, f3.ts)
    bundle(['changed', 'HEAD~1', '--since', 'HEAD~2'], dir),
    // HEAD~2 vs --since HEAD~1 -> --since wins -> 1 file changed (f3.ts)
    bundle(['changed', 'HEAD~2', '--since', 'HEAD~1'], dir),
  ])
  return { head1, sinceA, sinceB }
}

let fixtures: ReadonlyMap<number, Fixture>
let positional: Positional

// Every start runs here, together, so a row only asserts on a finished run: the hook carries the wait for the longest chain of starts, and a slow machine cannot spend one row's budget on another row's fixture.
beforeAll(async () => {
  const sizes = [1, 3, 6]
  const built = await Promise.all(sizes.map((count) => buildFixture(count)))
  fixtures = new Map(sizes.map((count, i) => [count, built[i] as Fixture] as const))
  positional = (fixtures.get(3) as Fixture).positional as Positional
})

const fixtureOf = (count: number): Fixture => fixtures.get(count) as Fixture

describe('changed [ref] positional wiring (exact-count)', () => {
  it('changed HEAD~1 resolves the positional ref, not the ignored-argument default path', () => {
    const r = positional.head1
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('git diff failed')
    const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(lines).toEqual(['f3.ts'])
  })

  it('--since takes precedence over the positional ref in both directions', () => {
    const { sinceA: a, sinceB: b } = positional
    expect(a.status, a.stderr).toBe(0)
    const aFiles = a.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(aFiles.sort()).toEqual(['f2.ts', 'f3.ts'])

    expect(b.status, b.stderr).toBe(0)
    const bFiles = b.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(bFiles).toEqual(['f3.ts'])

    expect(aFiles.length).not.toBe(bFiles.length)
  })
})

describe('changed default-ref hint on shallow repos (not a constant)', () => {
  it('a 3-commit repo names "3 commits" in the hint', () => {
    const r = fixtureOf(3).bare
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('git diff failed: fatal: ambiguous argument')
    expect(r.stderr).toContain('3 commits')
  })

  it('a 1-commit repo names "1 commit" (singular) in the hint, not "1 commits"', () => {
    const r = fixtureOf(1).bare
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('git diff failed: fatal: ambiguous argument')
    expect(r.stderr).toContain('1 commit')
    expect(r.stderr).not.toContain('1 commits')
  })

  it.each([1, 3])('the suggested --since ref in the hint resolves and runs cleanly in a %i-commit repo (executable-suggestion guard)', (count) => {
    const { bare, follow, suggestedRef } = fixtureOf(count)
    expect(bare.status).toBe(1)
    expect(suggestedRef, `no suggested-ref line found in stderr:\n${bare.stderr}`).not.toBeNull()
    expect(follow?.status, follow?.stderr).toBe(0)
  })
})

describe('changed bare default in a deep repo stays untouched (byte-identical sanity)', () => {
  it('a 6-commit repo resolves HEAD~5 without a hint appended', () => {
    const r = fixtureOf(6).bare
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('Hint:')
  })
})
