/** Guard: no git process token-goat starts can run without a time limit by accident. `runGit` takes its limit from `opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS`, so a call site that forgets one is bounded by the default instead of hanging a resident process (hook server, worker, MCP server) for good; the only opt-out is the named `GIT_UNBOUNDED`, and the files allowed to name it are listed below, each with a reason. Four checks: the fallback is in the spawn path (source), an omitted limit reaches spawnSync as the default and an explicit one wins (behaviour), `GIT_UNBOUNDED` appears only where allowed, and each scan sees a real population. */

// tg-no-regex-preload Provenance: HAND-DERIVED. The expected spawnSync `timeout` values follow from the stated contract (omitted -> default, positive number -> itself, GIT_UNBOUNDED -> none, 0/negative/NaN -> default) and are computed from the test inputs, not from the implementation; the esbuild rendering of util.ts is the real source.
import type * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

import { pinnedPopulation } from './population.js'

// Every call passes straight through to the real spawnSync; the mock exists so the options runGit hands it are inspectable.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cp>()
  return {
    ...actual,
    spawnSync: vi.fn((...args: Parameters<typeof actual.spawnSync>) => actual.spawnSync(...args)),
  }
})

import * as childProcess from 'node:child_process'

import { GIT_DEFAULT_TIMEOUT_MS, GIT_UNBOUNDED, runGit, runGitAsync } from '../../src/util.js'

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

describe('git calls are bounded', () => {
  it('every git spawn in util.ts takes its limit from gitTimeoutMs, whose fallback is `?? GIT_DEFAULT_TIMEOUT_MS`', () => {
    const spawns = gitSpawnCalls(UTIL_CODE)
    const fallbacks = [...UTIL_CODE.matchAll(/\?\? GIT_DEFAULT_TIMEOUT_MS\b/g)]
    expect(spawns.length, 'util.ts must start git somewhere, or this guard reads nothing').toBeGreaterThan(0)
    expect(fallbacks.length, 'gitTimeoutMs is the one place the default is applied').toBe(1)
    expect(UTIL_CODE.slice(UTIL_CODE.indexOf('function gitTimeoutMs'), fallbacks[0]!.index), 'the fallback must sit inside gitTimeoutMs').not.toMatch(/\nfunction |\nexport function /)
    for (const call of spawns) {
      const at = UTIL_CODE.indexOf(call)
      const start = Math.max(UTIL_CODE.lastIndexOf('\nfunction ', at), UTIL_CODE.lastIndexOf('\nexport function ', at))
      const end = UTIL_CODE.indexOf('\n}\n', at)
      const whole = UTIL_CODE.slice(start, end)
      expect(whole, 'a git spawn must ask gitTimeoutMs for its limit, so a new spawn path is bounded too').toMatch(/\bgitTimeoutMs\(/)
      // spawnSync enforces the limit itself; spawnOwned has no timeout option, so its function arms a timer that kills the tree.
      if (call.startsWith('spawnSync')) expect(call, 'the spawnSync options must carry the timeout').toMatch(/\btimeout\b/)
      else expect(whole, 'an owned git must be killed when its limit passes').toMatch(/\bsetTimeout\(/)
    }
  })

  it('an omitted timeout reaches spawnSync as the default, an explicit one wins, GIT_UNBOUNDED sends none', () => {
    const timeoutOf = (opts?: Parameters<typeof runGit>[1]): unknown => {
      vi.mocked(childProcess.spawnSync).mockClear()
      const result = runGit(['--version'], opts)
      expect(result.exitCode, result.stderr).toBe(0)
      const spawnOpts = vi.mocked(childProcess.spawnSync).mock.calls[0]?.[2] as Record<string, unknown> | undefined
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
    const armed = async (opts?: Parameters<typeof runGitAsync>[1]): Promise<unknown[]> => {
      const timers = vi.spyOn(globalThis, 'setTimeout')
      try {
        const result = await runGitAsync(['--version'], opts)
        expect(result.exitCode, result.stderr).toBe(0)
        return timers.mock.calls.map((call) => call[1])
      } finally {
        timers.mockRestore()
      }
    }
    expect(await armed()).toContain(GIT_DEFAULT_TIMEOUT_MS)
    expect(await armed({ timeoutMs: 1_234_567 })).toContain(1_234_567)
    expect(await armed({ timeoutMs: 0 })).toContain(GIT_DEFAULT_TIMEOUT_MS)
    expect(await armed({ timeoutMs: Number.NaN })).toContain(GIT_DEFAULT_TIMEOUT_MS)
    const unbounded = await armed({ timeoutMs: GIT_UNBOUNDED })
    expect(unbounded).not.toContain(GIT_DEFAULT_TIMEOUT_MS)
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
