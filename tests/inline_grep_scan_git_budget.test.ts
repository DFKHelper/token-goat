import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { SCOPE_MAX_FILES, SCOPE_MAX_LISTED, readScopeDir } from '../src/inline_grep_scan.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import type { GitResult, RunGitOptions } from '../src/types.js'
import { runGit } from '../src/util.js'
import { indexableDir } from './helpers/temp-config.js'

// HAND-DERIVED: the git calls of one scope decision share ONE deadline of 5000 ms (SCOPE_GIT_TIMEOUT_MS in inline_grep_scan.ts, which was the bound of each call). The fake clock moves only when a git call runs, by a fixed 1500 ms, so the timeouts handed to git are 5000, 3500, 2000 and 500 and the fifth call finds the deadline passed. No wall clock is read: the rows count calls and compare numbers. The listing cap is the constant the module exports.

const GIT_STEP_MS = 1_500
const BUDGET_MS = 5_000

interface Call {
  readonly args: readonly string[]
  readonly timeoutMs: number | symbol | undefined
}

/** A recording stand-in for runGit that runs the real git, and moves a fake clock by `step` ms after each call. */
function recorder(step: number): { calls: Call[]; deps: { git: (a: string[], o: RunGitOptions) => GitResult; now: () => number } } {
  const calls: Call[] = []
  let t = 1_000_000
  return {
    calls,
    deps: {
      git: (args, opts) => {
        calls.push({ args, timeoutMs: opts.timeoutMs })
        t += step
        return runGit(args, opts)
      },
      now: () => t,
    },
  }
}

/** A git work tree with the files written and indexed; maintenance is off so no detached git process outlives the test. */
function project(files: Record<string, string>): string {
  const dir = indexableDir()
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'init', '-q'], { cwd: dir, stdio: 'ignore' })
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text, 'utf8')
    if (name.endsWith('.py')) indexFileSync(path.join(dir, name), globalDbPath())
  }
  return dir
}

// An anchored rule (needs rev-parse) and a negated one (needs the hidden-file listing) make the scope run all six git calls.
const SIX_CALL_SCOPE = { 'mod.py': 'def unique_loader(path):\n    return 1\n', 'other.py': 'x = 1\n', '.ignore': '/zzz.txt\n!keep.txt\n' }

beforeEach(() => clearModuleCaches())
afterEach(() => clearModuleCaches())

describe('the git calls of one scope decision share one deadline', () => {
  it('runs six calls, each given the whole allowance, when the clock does not move', () => {
    const dir = project(SIX_CALL_SCOPE)
    const { calls, deps } = recorder(0)
    readScopeDir(dir, dir, deps)
    expect(calls.map((c) => c.args[2])).toEqual(['check-ignore', 'ls-files', 'ls-files', 'ls-files', 'rev-parse', 'ls-files'])
    expect(calls.map((c) => c.timeoutMs)).toEqual([BUDGET_MS, BUDGET_MS, BUDGET_MS, BUDGET_MS, BUDGET_MS, BUDGET_MS])
  })

  it('hands each call only the time left and spawns nothing once the deadline has passed', () => {
    const dir = project(SIX_CALL_SCOPE)
    const { calls, deps } = recorder(GIT_STEP_MS)
    const read = readScopeDir(dir, dir, deps)
    expect('passReason' in read, JSON.stringify(read)).toBe(true)
    expect(calls.map((c) => c.timeoutMs)).toEqual([5_000, 3_500, 2_000, 500])
    expect(calls).toHaveLength(4)
  })

  it('runs every call under the shared config, ahead of the subcommand', () => {
    const dir = project(SIX_CALL_SCOPE)
    const { calls, deps } = recorder(0)
    readScopeDir(dir, dir, deps)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.args.slice(0, 2)).toEqual(['-c', 'core.ignorecase=false'])
  })
})

// CAPTURE: git 2.53.0.windows.1, a scratch repo with a canary command (`echo x >> marker`) in each command-running config key: `git ls-files -z -co --exclude-standard`, `check-ignore -q`, `rev-parse --show-prefix` ran only the core.fsmonitor canary, and not even that under `-c core.fsmonitor=`. The row keeps that one in force on the real default path.
describe('a repo-local config key that runs a command', () => {
  it('does not run during a scope read, while the same canary does run under a bare git', () => {
    const dir = project({ 'mod.py': 'def unique_loader(path):\n    return 1\n' })
    const marker = path.join(dir, '..', 'fsmonitor-' + path.basename(dir) + '.marker').replace(/\\/g, '/')
    execFileSync('git', ['config', '--local', 'core.fsmonitor', 'echo x >> ' + marker], { cwd: dir })
    execFileSync('git', ['-c', 'maintenance.auto=false', 'ls-files', '-z', '-co', '--exclude-standard', '--', '.'], { cwd: dir, stdio: 'ignore' })
    expect(fs.existsSync(marker), 'the canary can fire, so its absence below means something').toBe(true)
    fs.rmSync(marker)
    readScopeDir(dir, dir)
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe('a git listing past the entry cap', () => {
  /** A fake git whose `ls-files -co` lists `n` entries and which says every other check is clean. */
  function listing(n: number): { calls: Call[]; deps: { git: (a: string[], o: RunGitOptions) => GitResult; now: () => number } } {
    const calls: Call[] = []
    const out = Array.from({ length: n }, (_, i) => 'f' + i + '.py\0').join('')
    return {
      calls,
      deps: {
        git: (args, opts) => {
          calls.push({ args, timeoutMs: opts.timeoutMs })
          if (args.includes('check-ignore')) return { stdout: '', stderr: '', exitCode: 1, unfinished: false }
          if (args.includes('-co') && !args.includes('-i')) return { stdout: out, stderr: '', exitCode: 0, unfinished: false }
          return { stdout: '', stderr: '', exitCode: 0, unfinished: false }
        },
        now: () => 1_000_000,
      },
    }
  }

  it('passes the Grep through without asking git anything more', () => {
    const { calls, deps } = listing(SCOPE_MAX_LISTED + 1)
    expect(readScopeDir('/nonexistent-scope', '/nonexistent-scope', deps)).toEqual({ passReason: 'git lists more than ' + SCOPE_MAX_LISTED + ' entries' })
    expect(calls).toHaveLength(3)
  })

  it('reaches the file-count check when the listing is exactly at the cap', () => {
    const { deps } = listing(SCOPE_MAX_LISTED)
    expect(readScopeDir('/nonexistent-scope', '/nonexistent-scope', deps)).toEqual({ passReason: 'the scope holds more than ' + SCOPE_MAX_FILES + ' files' })
  })
})
