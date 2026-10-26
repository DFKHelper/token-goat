/** The pre-push focused test run (.lefthook-scripts/run-test.sh) in a sandbox repo whose vitest is a shim that records its argv: a focus list past cmd.exe's 8191-character limit must reach vitest whole, in chunks that each fit, and a red chunk must fail the leg without hiding the others. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWindowsBash } from '../src/shell.js'

const REPO = process.cwd().replace(/\\/g, '/')
const posix = (p: string): string => p.replace(/\\/g, '/')
// Git Bash on Windows, never the WSL launcher that a bare bash resolves to there; null skips the suite where no bash exists
const BASH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/bash'
const MAX_CHUNK_CHARS = 20000
let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const SHIM = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + '\\n')
process.exit(args.some((a) => a.includes('FAILME')) ? 1 : 0)
`

/** Runs the script over the given focus list; returns its exit status and the argv of each vitest call. */
function run(paths: string[]): { status: number | null; calls: string[][] } {
  dir = mkdtempSync(path.join(tmpdir(), 'tg-runtest-'))
  const root = path.join(dir, 'repo')
  mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true })
  writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), SHIM)
  execFileSync('git', ['init', '-q', root])
  const focus = path.join(dir, 'focus.txt')
  const log = path.join(dir, 'calls.log')
  writeFileSync(focus, paths.join('\n') + '\n')
  writeFileSync(log, '')
  const r = spawnSync(BASH ?? 'bash', [`${REPO}/.lefthook-scripts/run-test.sh`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TG_PREPUSH_FOCUS: posix(focus), SHIM_LOG: log, PATH: `${path.dirname(BASH ?? '')}${path.delimiter}${process.env['PATH'] ?? ''}` },
  })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
  return { status: r.status, calls }
}

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `tests/some/nested/directory/with_a_long_name_${String(i).padStart(4, '0')}.test.ts`)

describe.skipIf(BASH === null)('pre-push focused run', () => {
  it('hands vitest every path of a list longer than the cmd.exe limit, in chunks that each fit', () => {
    const paths = many(800)
    expect(paths.join(' ').length).toBeGreaterThan(2 * MAX_CHUNK_CHARS)
    const r = run(paths)
    expect(r.status).toBe(0)
    expect(r.calls.length).toBeGreaterThan(1)
    for (const c of r.calls) {
      expect(c.slice(0, 1)).toEqual(['run'])
      expect(c.slice(1).join(' ').length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    }
    expect(r.calls.flatMap((c) => c.slice(1))).toEqual(paths)
  })

  it('runs a list past 8191 characters that still fits one chunk as a single call', () => {
    const paths = many(150)
    expect(paths.join(' ').length).toBeGreaterThan(8191)
    const r = run(paths)
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([['run', ...paths]])
  })

  it('fails the leg when one chunk fails, after running the rest', () => {
    const paths = many(800)
    paths[400] = 'tests/FAILME.test.ts'
    const r = run(paths)
    expect(r.status).toBe(1)
    expect(r.calls.flatMap((c) => c.slice(1))).toEqual(paths)
  })
})
