/** Guard: no git process token-goat starts can run without a time limit by accident. `runGit` takes its limit from `opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS`, so a call site that forgets one is bounded by the default instead of hanging a resident process (hook server, worker, MCP server) for good; the only opt-out is the named `GIT_UNBOUNDED`, and the files allowed to name it are listed below, each with a reason. Four checks: the fallback is in the spawn path (source), an omitted limit reaches spawnSync as the default and an explicit one wins (behaviour), `GIT_UNBOUNDED` appears only where allowed, and each scan sees a real population. */

// tg-no-regex-preload Provenance: HAND-DERIVED. The expected spawnSync `timeout` values follow from the stated contract (omitted -> default, positive number -> itself, GIT_UNBOUNDED -> none, 0/negative/NaN -> default) and are computed from the test inputs, not from the implementation; the esbuild rendering of util.ts is the real source.
import type * as cp from 'node:child_process'
import type * as processTree from '../../src/process_tree.js'
import type { GitResult } from '../../src/types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

import { pinnedPopulation } from './population.js'

// No git starts here: spawnSync and spawnOwned are stubs that record the options they are given and answer with a clean exit, and every other way to start a process throws. The claim under test is which limit is handed over, which the outcome of a real git adds nothing to and a loaded machine can only spoil.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cp>()
  const refuse = (name: string) => (): never => {
    throw new Error(`${name} would start a real process in a test that stubs every git spawn`)
  }
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '', output: ['', '', ''], pid: 0, signal: null })),
    spawn: vi.fn(refuse('spawn')),
    exec: vi.fn(refuse('exec')),
    execSync: vi.fn(refuse('execSync')),
    execFile: vi.fn(refuse('execFile')),
    execFileSync: vi.fn(refuse('execFileSync')),
    fork: vi.fn(refuse('fork')),
  }
})

vi.mock('../../src/process_tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof processTree>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return {
    ...actual,
    // A child that stays alive until the test emits its exit, so a timer the call arms can be fired while the call is pending; `kill` records the call and ends nothing.
    spawnOwned: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
      return { child, kill: vi.fn(), release: vi.fn() }
    }),
  }
})

import * as childProcess from 'node:child_process'

import { runGitAsync } from '../../src/git_async.js'
import { spawnOwned } from '../../src/process_tree.js'
import { GIT_DEFAULT_TIMEOUT_MS, GIT_UNBOUNDED, runGit } from '../../src/util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Files that may name `GIT_UNBOUNDED`, as `src/`-relative paths, each with the reason it was read and verified. Initially these two only: the symbol's definition and runGit's own comparison. A call site that wants to run git without a limit adds itself here with a reason a reviewer can check. */
const GIT_UNBOUNDED_ALLOWED: Readonly<Record<string, string>> = {
  'types.ts': 'defines the symbol and types RunGitOptions.timeoutMs with it; no git call',
  'util.ts': 'runGit compares timeoutMs against it to leave spawnSync without a timeout; no caller of its own',
}

/** The source with every comment removed. esbuild parses it, so a `//` inside a string is never taken for a comment. */
function withoutComments(source: string): string {
  return transformSync(source, { loader: 'ts', legalComments: 'none' }).code
}

function walkSrc(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkSrc(full))
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The text of every call that starts git in `code`: from `spawnSync(gitExecutable()` to the end of its options object, found by balancing parentheses. */
function gitSpawnCalls(code: string): string[] {
  const calls: string[] = []
  for (const m of code.matchAll(/(?:spawnSync|spawnOwned)\(\s*gitExecutable\(\)/g)) {
    let depth = 0
    let end = m.index
    for (let i = code.indexOf('(', m.index); i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) {
        end = i + 1
        break
      }
    }
    calls.push(code.slice(m.index, end))
  }
  return calls
}

const UTIL_CODE = withoutComments(fs.readFileSync(path.join(SRC_DIR, 'util.ts'), 'utf8'))
const GIT_ASYNC_CODE = withoutComments(fs.readFileSync(path.join(SRC_DIR, 'git_async.ts'), 'utf8'))

describe('git calls are bounded', () => {
  it('every git spawn in util.ts and git_async.ts takes its limit from gitTimeoutMs, whose fallback is `?? GIT_DEFAULT_TIMEOUT_MS`', () => {
    const spawnsByCode = [UTIL_CODE, GIT_ASYNC_CODE].map((code) => ({ code, spawns: gitSpawnCalls(code) }))
    const fallbacks = [...UTIL_CODE.matchAll(/\?\? GIT_DEFAULT_TIMEOUT_MS\b/g)]
    for (const entry of spawnsByCode) expect(entry.spawns.length, 'util.ts and git_async.ts must each start git, or this guard reads nothing').toBeGreaterThan(0)
    expect(fallbacks.length, 'gitTimeoutMs is the one place the default is applied').toBe(1)
    expect(UTIL_CODE.slice(UTIL_CODE.indexOf('function gitTimeoutMs'), fallbacks[0]!.index), 'the fallback must sit inside gitTimeoutMs').not.toMatch(/\nfunction |\nexport function /)
    for (const { code, spawns } of spawnsByCode) for (const call of spawns) {
      const at = code.indexOf(call)
      const start = Math.max(code.lastIndexOf('\nfunction ', at), code.lastIndexOf('\nexport function ', at))
      const end = code.indexOf('\n}\n', at)
      const whole = code.slice(start, end)
      expect(whole, 'a git spawn must ask gitTimeoutMs for its limit, so a new spawn path is bounded too').toMatch(/\bgitTimeoutMs\(/)
      // spawnSync enforces the limit itself; spawnOwned has no timeout option, so its function arms a timer that kills the tree.
      if (call.startsWith('spawnSync')) expect(call, 'the spawnSync options must carry the timeout').toMatch(/\btimeout\b/)
      else expect(whole, 'an owned git must be killed when its limit passes').toMatch(/\bsetTimeout\(/)
    }
  })

  it('an omitted timeout reaches spawnSync as the default, an explicit one wins, GIT_UNBOUNDED sends none', () => {
    const timeoutOf = (opts?: Parameters<typeof runGit>[1]): unknown => {
      vi.mocked(childProcess.spawnSync).mockClear()
      runGit(['--version'], opts)
      expect(vi.mocked(childProcess.spawnSync).mock.calls, 'runGit must make exactly one spawn').toHaveLength(1)
      const spawnOpts = (vi.mocked(childProcess.spawnSync).mock.calls[0] as unknown[])[2] as Record<string, unknown> | undefined
      return spawnOpts?.['timeout']
    }
    expect(timeoutOf()).toBe(GIT_DEFAULT_TIMEOUT_MS)
    expect(timeoutOf({})).toBe(GIT_DEFAULT_TIMEOUT_MS)
    expect(timeoutOf({ timeoutMs: 1234 })).toBe(1234)
    expect(timeoutOf({ timeoutMs: GIT_UNBOUNDED })).toBeUndefined()
    // A configured hints.git_hint_max_ms of 0 used to reach spawnSync as "no limit".
    expect(timeoutOf({ timeoutMs: 0 })).toBe(GIT_DEFAULT_TIMEOUT_MS)
    expect(timeoutOf({ timeoutMs: -5 })).toBe(GIT_DEFAULT_TIMEOUT_MS)
    expect(timeoutOf({ timeoutMs: Number.NaN })).toBe(GIT_DEFAULT_TIMEOUT_MS)
  })

  it('runGitAsync arms the same limit: omitted is the default, explicit wins, GIT_UNBOUNDED arms none', async () => {
    // Lets the call reach its pending state on events alone: every microtask already queued runs, with no clock; a timer armed after an await is armed by then.
    const SETTLE_HOPS = 8
    const flush = async (): Promise<void> => {
      for (let hop = 0; hop < SETTLE_HOPS; hop++) await Promise.resolve()
    }
    // Runs one call to its end with a child that never exits by itself: fires the timers the call armed, then lets the child exit. A git timer is told by what it does (it ends the child through kill), not by its delay alone. The spy stays on until the call has settled, so a timer armed late is seen too.
    const drive = async (opts: Parameters<typeof runGitAsync>[1], delay: number | undefined): Promise<{ result: GitResult; kills: number; fired: number; late: number }> => {
      vi.mocked(spawnOwned).mockClear()
      const timers = vi.spyOn(globalThis, 'setTimeout')
      let owned: { child: { emit: (event: string, ...args: unknown[]) => boolean }; kill: ReturnType<typeof vi.fn> } | undefined
      let pending: Promise<GitResult> | undefined
      try {
        pending = runGitAsync(['--version'], opts)
        await flush()
        expect(vi.mocked(spawnOwned).mock.calls, 'runGitAsync must make exactly one spawn').toHaveLength(1)
        const spawned = vi.mocked(spawnOwned).mock.results[0]!.value as NonNullable<typeof owned>
        owned = spawned
        const armed = timers.mock.calls.map((call) => [...call])
        // A bounded call is held to the timers of its delay; an unbounded one to every timer it armed.
        const fire = armed.filter((call) => delay === undefined || call[1] === delay)
        for (const call of fire) (call[0] as () => void)()
        const kills = spawned.kill.mock.calls.length
        spawned.child.emit('exit', kills > 0 ? null : 0)
        spawned.child.emit('close', kills > 0 ? null : 0)
        const result = await pending
        await flush()
        return { result, kills, fired: fire.length, late: timers.mock.calls.length - armed.length }
      } finally {
        owned?.child.emit('close', 0)
        if (pending) await pending
        timers.mockRestore()
      }
    }
    const expectTimesOut = async (opts: Parameters<typeof runGitAsync>[1], delay: number): Promise<void> => {
      const { result, kills, fired } = await drive(opts, delay)
      expect(fired, `a timer of ${delay} ms must be armed`).toBeGreaterThan(0)
      expect(kills, `the timer of ${delay} ms must end the git tree`).toBeGreaterThan(0)
      expect(result.timedOut, 'the call must report the timeout').toBe(true)
      expect(result.stderr, 'the timeout message must name the limit that applied').toContain(`after ${delay} ms`)
    }
    await expectTimesOut(undefined, GIT_DEFAULT_TIMEOUT_MS)
    await expectTimesOut({ timeoutMs: 1_234_567 }, 1_234_567)
    await expectTimesOut({ timeoutMs: 0 }, GIT_DEFAULT_TIMEOUT_MS)
    await expectTimesOut({ timeoutMs: Number.NaN }, GIT_DEFAULT_TIMEOUT_MS)
    // Whatever delay an unbounded call arms, firing every timer it armed must neither end the child nor mark the call timed out.
    const unbounded = await drive({ timeoutMs: GIT_UNBOUNDED }, undefined)
    expect(unbounded.late, 'an unbounded git must arm no timer once it has exited').toBe(0)
    expect(unbounded.kills, 'an unbounded git must not be ended by a timer').toBe(0)
    expect(unbounded.result.timedOut, 'an unbounded git must not time out').toBeUndefined()
    expect(unbounded.result.exitCode, 'the unbounded call must run to the exit of its child').toBe(0)
  })

  it('GIT_UNBOUNDED is named only by the allowlisted files', () => {
    const files = pinnedPopulation({
      what: 'src/**/*.ts files scanned for GIT_UNBOUNDED',
      items: walkSrc(SRC_DIR).map((f) => f.split(path.sep).join('/')),
      floor: 150,
      mustInclude: ['src/util.ts', 'src/types.ts', 'src/project.ts', 'src/read_git.ts'],
    })
    const users = files
      .filter((f) => /\bGIT_UNBOUNDED\b/.test(withoutComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC_DIR, f).split(path.sep).join('/'))
    const unexplained = users.filter((f) => GIT_UNBOUNDED_ALLOWED[f] === undefined || GIT_UNBOUNDED_ALLOWED[f] === '')
    expect(unexplained, 'a file that runs git without a limit must be added to GIT_UNBOUNDED_ALLOWED with a reason').toEqual([])
    expect(users, 'the allowlist names a file that no longer uses GIT_UNBOUNDED').toEqual(Object.keys(GIT_UNBOUNDED_ALLOWED).sort())
  })

  // Provenance: HAND-DERIVED. Each snippet is a made-up source written to be, or not to be, a use by reading it.
  it.each([
    ["runGit(['log'], { timeoutMs: GIT_UNBOUNDED })", true],
    ["const opts = { ...base, timeoutMs: GIT_UNBOUNDED }", true],
    ["const key = 'timeoutMs'; runGit(args, { [key]: GIT_UNBOUNDED })", true],
    ["import { GIT_UNBOUNDED } from './util.js'\nrunGit(a, { timeoutMs: GIT_UNBOUNDED })", true],
    ["export { GIT_UNBOUNDED } from './util.js'", true],
    // An import nothing uses compiles to nothing, so it cannot unbound a call.
    ["import { GIT_UNBOUNDED } from './util.js'", false],
    ["// timeoutMs: GIT_UNBOUNDED is the opt-out", false],
    ["const GIT_UNBOUNDED_X = 1", false],
  ])('the scan reads %s as use=%s', (source, expected) => {
    expect(/\bGIT_UNBOUNDED\b/.test(withoutComments(source))).toBe(expected)
  })
})
