/** Guard against two regressions in `token-goat changed`: (a) `.command('changed')` was registered with no positional argument spec, so Commander silently dropped a `changed <ref>` invocation (the exact form README documents) — the run always fell through to the `HEAD~5` default with no error and no signal the argument was ignored. (b) the `HEAD~5` default fails on any repo with fewer than 6 commits (a fresh checkout, a shallow CI clone, a new project) with raw git stderr that names no working alternative, even though `--since` exists and would fix it. These run the real built bundle against real git fixtures so a severed positional-argument wire, or a hardcoded/non-resolving hint, cannot pass by accident (a mocked `runGit` call sequence could satisfy either without exercising the actual CLI argument plumbing). */
// tg-no-regex-preload: spawns the built bundle or runs a subprocess and never calls the parser in this process

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

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

// A process start costs seconds on a slow or busy machine, so the work is cut three ways: each fixture repo is three git starts however many commits it holds, the bundle runs one row needs are started together, and each piece is built the first time a row asks for it and shared by every later row (a memoized promise, never a repeat start). A row therefore waits only for the starts it reads, so no single deadline covers the whole file's processes, and a slow machine cannot spend one row's budget on another row's fixture. Each run ends on its own timeout (execFile kills the child).
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

interface Positional {
  readonly head1: RunResult
  readonly sinceA: RunResult
  readonly sinceB: RunResult
}

/** The bare `token-goat changed` run in the repo of `commitCount` commits, which resolves the default HEAD~5, and `changed --since <ref>` with the ref its hint suggested (null when it suggested none). */
interface Hinted {
  readonly bare: RunResult
  readonly follow: RunResult | null
  readonly suggestedRef: string | null
}

/** Memoizes `make` per key: the first ask starts the work, every later ask shares its promise, so nothing is ever started twice and nothing starts before a row needs it. */
function memoized<K, V>(make: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>()
  return (key) => {
    let pending = cache.get(key)
    if (pending === undefined) {
      pending = make(key)
      cache.set(key, pending)
    }
    return pending
  }
}

const repoOf = memoized((commitCount: number) => buildRepo(commitCount))

const hintedOf = memoized(async (commitCount: number): Promise<Hinted> => {
  const dir = await repoOf(commitCount)
  const bare = await bundle(['changed'], dir)
  const suggestedRef = /token-goat changed --since (\S+)/.exec(bare.stderr)?.[1] ?? null
  const follow = suggestedRef === null ? null : await bundle(['changed', '--since', suggestedRef], dir)
  return { bare, follow, suggestedRef }
})

/** The positional-ref runs, made in the 3-commit repo only and started together. */
const positionalOf = memoized(async (_: 'three'): Promise<Positional> => {
  const dir = await repoOf(3)
  const [head1, sinceA, sinceB] = await Promise.all([
    bundle(['changed', 'HEAD~1'], dir),
    // HEAD~1 vs --since HEAD~2 -> --since wins -> 2 files changed (f2.ts, f3.ts)
    bundle(['changed', 'HEAD~1', '--since', 'HEAD~2'], dir),
    // HEAD~2 vs --since HEAD~1 -> --since wins -> 1 file changed (f3.ts)
    bundle(['changed', 'HEAD~2', '--since', 'HEAD~1'], dir),
  ])
  return { head1, sinceA, sinceB }
})

describe('changed [ref] positional wiring (exact-count)', () => {
  it('changed HEAD~1 resolves the positional ref, not the ignored-argument default path', async () => {
    const r = (await positionalOf('three')).head1
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('git diff failed')
    const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(lines).toEqual(['f3.ts'])
  })

  it('--since takes precedence over the positional ref in both directions', async () => {
    const { sinceA: a, sinceB: b } = await positionalOf('three')
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
  it('a 3-commit repo names "3 commits" in the hint', async () => {
    const r = (await hintedOf(3)).bare
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('git diff failed: fatal: ambiguous argument')
    expect(r.stderr).toContain('3 commits')
  })

  it('a 1-commit repo names "1 commit" (singular) in the hint, not "1 commits"', async () => {
    const r = (await hintedOf(1)).bare
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('git diff failed: fatal: ambiguous argument')
    expect(r.stderr).toContain('1 commit')
    expect(r.stderr).not.toContain('1 commits')
  })

  it.each([1, 3])('the suggested --since ref in the hint resolves and runs cleanly in a %i-commit repo (executable-suggestion guard)', async (count) => {
    const { bare, follow, suggestedRef } = await hintedOf(count)
    expect(bare.status).toBe(1)
    expect(suggestedRef, `no suggested-ref line found in stderr:\n${bare.stderr}`).not.toBeNull()
    expect(follow?.status, follow?.stderr).toBe(0)
  })
})

describe('changed bare default in a deep repo stays untouched (byte-identical sanity)', () => {
  it('a 6-commit repo resolves HEAD~5 without a hint appended', async () => {
    const r = (await hintedOf(6)).bare
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('Hint:')
  })
})
