/** The pre-push hard stop's pure pieces: the stop value read from the environment (scripts/prepush-budget.mjs), the planned files a stopped leg did not finish (scripts/prepush-failed.mjs unfinishedFiles), and the owed record written beside the failed-store. The shell watchdog itself is exercised by a scratch run, not here. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HARD_STOP_DEFAULT_S, hardStopOf } from '../scripts/prepush-budget.mjs'
import { unfinishedFiles, writeOwed } from '../scripts/prepush-failed.mjs'

describe('pre-push hard stop value', () => {
  it('defaults to the hook limit less the held-back share', () => {
    expect(hardStopOf({})).toEqual({ seconds: 540, source: 'default' })
    expect(HARD_STOP_DEFAULT_S).toBe(540)
  })

  it('takes a positive whole number from PREPUSH_HARD_STOP_S', () => {
    expect(hardStopOf({ PREPUSH_HARD_STOP_S: '5' })).toEqual({ seconds: 5, source: 'PREPUSH_HARD_STOP_S=5' })
  })

  it('caps a value above the hook limit at the limit', () => {
    expect(hardStopOf({ PREPUSH_HARD_STOP_S: '9999' }).seconds).toBe(600)
  })

  it.each(['0', 'abc', '-3', '2.5', '1e3'])('ignores %s and says so', (raw) => {
    const h = hardStopOf({ PREPUSH_HARD_STOP_S: raw })
    expect(h.seconds).toBe(540)
    expect(h.source).toContain('is not a positive whole number, ignored')
  })
})

describe('unfinishedFiles', () => {
  const plan = 'tests/a.test.ts\ntests/b.test.ts\ntests/c.test.ts\ntests/d.test.ts\n'

  it('returns the planned files with no result line, in plan order', () => {
    const log = [' ✓ tests/a.test.ts (3 tests) 120ms', ' ❯ tests/c.test.ts (2 tests | 1 failed) 90ms', ''].join('\n')
    expect(unfinishedFiles(plan, log)).toEqual(['tests/b.test.ts', 'tests/d.test.ts'])
  })

  it('treats a failing file with a FAIL line and no timing line as finished', () => {
    const log = [' FAIL  tests/b.test.ts > suite > case', ' ✓ tests/a.test.ts (1 test) 5ms'].join('\n')
    expect(unfinishedFiles(plan, log)).toEqual(['tests/c.test.ts', 'tests/d.test.ts'])
  })

  it('owes the whole plan when the log is empty', () => {
    expect(unfinishedFiles(plan, '')).toHaveLength(4)
  })

  it('does not treat a longer file name as the planned one', () => {
    const log = ' ✓ tests/a.test.tsx (1 test) 5ms'
    expect(unfinishedFiles('tests/a.test.ts\n', log)).toEqual(['tests/a.test.ts'])
  })
})

describe('writeOwed', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-owed-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes owed-<leg>.txt beside the store, one file per line', () => {
    const store = path.join(dir, 'token-goat-prepush', 'last-failed.json')
    const file = writeOwed(store, 'win', ['tests/b.test.ts', 'tests/d.test.ts'])
    expect(file).toBe(path.join(dir, 'token-goat-prepush', 'owed-win.txt'))
    expect(readFileSync(file, 'utf8')).toBe('tests/b.test.ts\ntests/d.test.ts\n')
  })

  it('refuses a leg name that is not a plain word, so it cannot leave the store directory', () => {
    expect(() => writeOwed(path.join(dir, 'last-failed.json'), '../win', ['tests/a.test.ts'])).toThrow(/not a plain word/)
  })
})

// Git Bash on Windows: a bare `bash` may be WSL's, so the Windows path is spelled out.
const GIT_BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const CAP_SCRIPT = fileURLToPath(new URL('../.lefthook-scripts/prepush-cap.sh', import.meta.url))
const slash = (p: string): string => p.replace(/\\/g, '/')

describe('cap_run_stoppable', () => {
  const bashAvailable = process.platform !== 'win32' || existsSync(GIT_BASH)
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-cap-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Runs one bash script that sources the cap, then prints the status of cap_run_stoppable. The flag appears one second in; the child would run for 20 s if nothing ended it.
  const runCap = (stepArgs: string): { stdout: string; stderr: string } => {
    const flag = slash(path.join(dir, 'hard-stop.flag'))
    const script = path.join(dir, 'run.sh')
    writeFileSync(
      script,
      [
        `source "${slash(CAP_SCRIPT)}"`,
        `HARD_FLAG="${flag}"`,
        'PIDS=()',
        `(sleep 1; : > "${flag}") &`,
        'WATCH=$!',
        `cap_run_stoppable "${slash(dir)}" "${slash(path.join(dir, 'out.txt'))}" ${stepArgs}`,
        'echo "rc=$?"',
        'kill "$WATCH" 2>/dev/null || true',
      ].join('\n') + '\n',
    )
    const r = spawnSync(GIT_BASH, [slash(script)], { encoding: 'utf8', timeout: 60_000 })
    return { stdout: r.stdout, stderr: r.stderr }
  }

  it.skipIf(!bashAvailable)('ends a step still running at the stop and returns the stop status', () => {
    const r = runCap(`"${slash(process.execPath)}" -e "setTimeout(() => {}, 20000)"`)
    expect(r.stdout).toContain('rc=125')
  })

  it.skipIf(!bashAvailable)('returns a finished step its own status', () => {
    const r = runCap(`"${slash(process.execPath)}" -e "process.exit(3)"`)
    expect(r.stdout).toContain('rc=3')
  })
})
