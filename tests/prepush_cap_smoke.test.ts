/** The pre-push hard stop's pure pieces: the stop value read from the environment (scripts/prepush-budget.mjs), the planned files a stopped leg did not finish (scripts/prepush-failed.mjs unfinishedFiles), and the owed record written beside the failed-store. The shell side runs for real below: the watchdog and kill_tree sourced alone, and the whole hook over stub legs. */
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HARD_STOP_DEFAULT_S, HARD_STOP_MAX_S, HOOK_LIMIT_S, STARTUP_RESERVE_S, STOP_CLEANUP_S, TERM_WAIT_S, hardStopOf, postStopOf } from '../scripts/prepush-budget.mjs'
import { unfinishedFiles, writeOwed } from '../scripts/prepush-failed.mjs'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'

// Bound on every spawned hook or bash run in this file; a run that reaches it is killed and fails the row.
const SPAWN_TIMEOUT_MS = 60_000

describe('pre-push hard stop value', () => {
  it('defaults to the hook limit less the held-back share', () => {
    expect(hardStopOf({})).toEqual({ seconds: 540, source: 'default' })
    expect(HARD_STOP_DEFAULT_S).toBe(540)
  })

  it('takes a positive whole number from PREPUSH_HARD_STOP_S', () => {
    expect(hardStopOf({ PREPUSH_HARD_STOP_S: '5' })).toEqual({ seconds: 5, source: 'PREPUSH_HARD_STOP_S=5' })
  })

  it('clamps a value above the default to the default, since the variable may only lower the stop, and says so', () => {
    expect(HARD_STOP_MAX_S).toBe(HARD_STOP_DEFAULT_S)
    expect(hardStopOf({ PREPUSH_HARD_STOP_S: '9999' }).seconds).toBe(HARD_STOP_DEFAULT_S)
    expect(hardStopOf({ PREPUSH_HARD_STOP_S: '9999' }).source).toContain('capped at')
  })

  it.each([300, 539, 540, 541, 570, 590, 600])('PREPUSH_HARD_STOP_S=%i is kept when it lowers the stop or equals the default, clamped when above, and keeps stop + term + post + cleanup + startup reserve within the hook limit', (raw) => {
    const stop = hardStopOf({ PREPUSH_HARD_STOP_S: String(raw) })
    const sum = stop.seconds + TERM_WAIT_S + postStopOf(stop.seconds, {}).seconds + STOP_CLEANUP_S + STARTUP_RESERVE_S
    expect(stop.seconds).toBeLessThanOrEqual(HARD_STOP_DEFAULT_S)
    expect(sum, `stop ${raw} gave ${stop.seconds} and a tail summing to ${sum}`).toBeLessThanOrEqual(HOOK_LIMIT_S)
    expect(stop.seconds).toBe(Math.min(raw, HARD_STOP_DEFAULT_S))
    if (raw > HARD_STOP_MAX_S) expect(stop.source).toContain('capped at')
    else expect(stop.source).not.toContain('capped at')
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
// How long after the hook's exit the cleanup process may keep ending legs, read from the script so a change to the constant cannot pass unnoticed.
const REAP_GRACE_S = Number(/^REAP_GRACE_S=(\d+)$/m.exec(readFileSync(CAP_SCRIPT, 'utf8'))?.[1])

describe('cap_run_stoppable', () => {
  const bashAvailable = process.platform !== 'win32' || existsSync(GIT_BASH)
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-cap-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  // Registered after the removal above, so it runs first (stack order): the stopped step runs in dir and the cleanup process ends its tree just after the hook returns, so the directory is busy for a moment.
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

  // Runs one bash script that sources the cap, then prints the status of cap_run_stoppable. The flag appears one second in; the child would run for 20 s if nothing ended it.
  const runCap = (stepArgs: string): { stdout: string; stderr: string } => {
    const flag = slash(path.join(dir, 'hard-stop.flag'))
    const script = path.join(dir, 'run.sh')
    writeFileSync(
      script,
      [
        `echo "$(cat /proc/$$/winpid 2>/dev/null || echo $$)" >"${slash(path.join(dir, 'bash.pid'))}"`,
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
    const r = spawnSync(GIT_BASH, [slash(script)], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })
    // A timed-out spawn kills only bash; the step's node child and the watchdog sleep would outlive it, so their tree goes with bash.
    if (r.error) endRecordedTrees([path.join(dir, 'bash.pid')])
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

describe('postStopOf', () => {
  it('gives the stopped legs what is left of the hook limit after the stop, less the TERM wait and the cleanup', () => {
    expect(postStopOf(HARD_STOP_DEFAULT_S, {})).toEqual({ seconds: 20, source: 'default' })
    expect(HARD_STOP_DEFAULT_S + postStopOf(HARD_STOP_DEFAULT_S, {}).seconds + TERM_WAIT_S + STOP_CLEANUP_S + STARTUP_RESERVE_S).toBe(HOOK_LIMIT_S)
  })

  it('takes a shorter positive whole number from PREPUSH_POST_STOP_S', () => {
    expect(postStopOf(540, { PREPUSH_POST_STOP_S: '2' }).seconds).toBe(2)
  })

  it('caps PREPUSH_POST_STOP_S at what is left of the hook limit', () => {
    expect(postStopOf(540, { PREPUSH_POST_STOP_S: '999' }).seconds).toBe(20)
  })

  it.each(['0', 'x', '1.5'])('ignores %s and says so', (raw) => {
    const p = postStopOf(540, { PREPUSH_POST_STOP_S: raw })
    expect(p.seconds).toBe(20)
    expect(p.source).toContain('is not a positive whole number, ignored')
  })
})

describe('the stop budget sums to within the hook limit', () => {
  it('holds for every hard stop the budget does not cap', () => {
    for (let stop = 1; stop <= HARD_STOP_MAX_S; stop++) {
      expect(stop + postStopOf(stop, {}).seconds + TERM_WAIT_S + STOP_CLEANUP_S + STARTUP_RESERVE_S).toBeLessThanOrEqual(HOOK_LIMIT_S)
    }
  })

  it('is what the shell reads at hook start: stop, limit, post-stop, TERM wait, cleanup, source', () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PREPUSH_')) env[k] = v
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/prepush-budget.mjs', import.meta.url)), 'hard-stop'], { env, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })
    const [stop, limit, post, term, cleanup] = r.stdout.trim().split(' ').map(Number)
    expect([stop, limit, post, term, cleanup]).toEqual([HARD_STOP_DEFAULT_S, HOOK_LIMIT_S, 20, TERM_WAIT_S, STOP_CLEANUP_S])
    expect((stop ?? 0) + (post ?? 0) + (term ?? 0) + (cleanup ?? 0) + STARTUP_RESERVE_S).toBeLessThanOrEqual(HOOK_LIMIT_S)
  })
})

describe('the watchdog and kill_tree, sourced alone', () => {
  const bashAvailable = process.platform !== 'win32' || existsSync(GIT_BASH)
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-watch-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Runs a bash script under the hook's own `set -euo pipefail` that sources the cap, then the given lines.
  const runScript = (lines: string[]): { status: number | null; out: string } => {
    const script = path.join(dir, 'run.sh')
    writeFileSync(script, ['set -euo pipefail', `source "${slash(CAP_SCRIPT)}"`, ...lines].join('\n') + '\n')
    const r = spawnSync(GIT_BASH, [slash(script)], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  // The watchdog on its real clock with no legs: the flag holds the hook-clock second it fired at, which must be the stop within one tick.
  it.skipIf(!bashAvailable)('writes the stop flag within 2 s of the configured stop', () => {
    const flag = slash(path.join(dir, 'hard-stop.flag'))
    const r = runScript(['cap_tick_open', 'SECONDS=0', `cap_watch "$$" 4 "${flag}" &`, 'wait $!', `echo "flag=$(cat "${flag}")"`])
    const m = /flag=(\d+)/.exec(r.out)
    expect(m, r.out).not.toBeNull()
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(4)
    expect(Number(m?.[1])).toBeLessThanOrEqual(4 + 2)
  })

  // Regression: under set -e, kill_tree's winpid="$(cat /proc/PID/winpid)" ended the whole hook when the leg exited after the readability test and before the cat, so no notice or legs line printed and the push failed with status 1. cat is a failing function here, which makes that moment deterministic.
  it.skipIf(process.platform !== 'win32' || !bashAvailable)('kill_tree goes on when a leg left no readable winpid', () => {
    const r = runScript(['cat() { return 1; }', 'taskkill() { echo "taskkill called $*"; }', 'kill_tree "$$"', 'echo "after kill_tree"'])
    expect(r.out).toContain('after kill_tree')
    expect(r.out).not.toContain('taskkill called')
    expect(r.status, r.out).toBe(0)
  })
})

// The hook's own stop path, run for real: a temp copy of .lefthook-scripts and scripts, with the four leg scripts replaced by stubs that sleep for a set time and record their pid. The seam is the copy; nothing in the hook is stubbed but the legs.
describe('the hard stop ends the legs of a real hook run', () => {
  const bashAvailable = process.platform !== 'win32' || existsSync(GIT_BASH)
  const REPO = fileURLToPath(new URL('..', import.meta.url))
  // The stop fires as an event, not on the clock. The hook's start-up and planning are about 25 process starts before the first leg, 0.1 s each on a quiet host and 2 to 3 s each on this loaded Windows one (a stop timed against that start-up fired before any leg began, 2026-10-27), so a stub leg ends the watchdog by TERM once it has started: the watchdog's own TERM trap exits it, which wait_legs reads as the stop. HOOK_STOP_S is only the watchdog's own deadline, set past anything a row reaches.
  const HOOK_STOP_S = 300
  const POST_STOP_S = 2
  // Bash start-up before the hook's first line and process exit after its EXIT trap run outside the hook's clock, and the hook forks about six more processes after the stop (the reused-lines grep, the outcome record, the cut report) that no clock bounds, up to 3 s each on a loaded Windows host; this is that slack, stated, not measured.
  const SPAWN_SLACK_S = 20
  // From the event to the hook's return: the post-stop allowance, the TERM wait, the cleanup the hook keeps for itself, plus the spawn slack. A hook that waited for a stopped leg takes that leg's whole sleep, far past this.
  const TAIL_BOUND_S = POST_STOP_S + TERM_WAIT_S + STOP_CLEANUP_S + SPAWN_SLACK_S
  const LEGS = [
    { file: 'run-typecheck.sh', leg: 'typecheck', env: 'STUB_TYPECHECK_S' },
    { file: 'run-ts-checks.sh', leg: 'ts-checks', env: 'STUB_TS_CHECKS_S' },
    { file: 'run-test.sh', leg: 'tests', env: 'STUB_TESTS_S' },
    { file: 'wsl-test.sh', leg: 'wsl-test', env: 'STUB_WSL_S' },
  ] as const
  let dir = ''
  let stubs = ''
  let leftLegs = false
  let leftHung = false
  // How long the hung node stub sleeps: past the tail bound, so a hook that waits for it fails the bound.
  const HANG_S = 80

  const stubSource = (leg: (typeof LEGS)[number], ignoresTerm: boolean): string =>
    [
      '#!/usr/bin/env bash',
      `echo "$(cat /proc/$$/winpid 2>/dev/null || echo $$)" >"$STUB_DIR/${leg.leg}.pid"`,
      ignoresTerm ? "trap '' TERM" : '',
      // The leg named by STUB_FIRE_STOP fires the stop once it is running, then sleeps like any other leg.
      // With STUB_FIRE_AFTER_TESTS the firing leg waits for the tests leg's done file and then 3 s, so the hook has read that leg's end before the stop comes.
      `if [[ "\${STUB_FIRE_STOP:-}" == "${leg.leg}" && "\${STUB_FIRE_AFTER_TESTS:-}" == "1" ]]; then`,
      '  until [[ -e "$STUB_DIR/tests.done" ]]; do sleep 1; done',
      '  sleep 3',
      'fi',
      `if [[ "\${STUB_FIRE_STOP:-}" == "${leg.leg}" ]]; then`,
      '  printf "%s\\n" "$EPOCHREALTIME" >"$STUB_DIR/fired.epoch"',
      '  kill -TERM "$(cat "$TMPDIR"/token-goat-pre-push.*/hard-stop.pid)"',
      'fi',
      `sleep "\${${leg.env}:-0}"`,
      `: >"$STUB_DIR/${leg.leg}.done"`,
      '',
    ].join('\n')

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-hook-'))
    stubs = path.join(dir, 'stubs')
    mkdirSync(stubs)
    cpSync(path.join(REPO, '.lefthook-scripts'), path.join(dir, '.lefthook-scripts'), { recursive: true })
    cpSync(path.join(REPO, 'scripts'), path.join(dir, 'scripts'), { recursive: true })
    for (const leg of LEGS) {
      writeFileSync(path.join(dir, '.lefthook-scripts', leg.file), stubSource(leg, leg.leg === 'wsl-test'))
    }
    expect(spawnSync('git', ['init', '-q'], { cwd: dir, timeout: SPAWN_TIMEOUT_MS }).status).toBe(0)
    const commit = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, timeout: SPAWN_TIMEOUT_MS })
    expect(commit.status).toBe(0)
  })

  afterEach(() => {
    // Only a run that did not return (or a leg known to survive its kill) can leave a live leg; a leg the hook ended is not signalled again, since its pid may be reused.
    if (leftLegs) endRecordedTrees(LEGS.map((leg) => path.join(stubs, `${leg.leg}.pid`)))
    leftLegs = false
    if (leftHung) endRecordedTrees([path.join(stubs, 'hung.pid')])
    leftHung = false
    rmSync(dir, { recursive: true, force: true })
  })

  // tailS: seconds from the stub's stop event to the hook's return, or null when no stub fired one.
  // A hook row has no wall-clock budget of its own: the hook's start-up is bounded by the hard stop it runs under, so the row may take that stop and the tail, as a hang guard (vitest's 60 s default is for rows that spawn one short script).
  const HOOK_ROW_TIMEOUT_MS = (HOOK_STOP_S + TAIL_BOUND_S) * 1000
  const hookRow = (name: string, fn: () => void, onlyWindows = false): void => {
    it.skipIf(!bashAvailable || (onlyWindows && process.platform !== 'win32'))(name, fn, HOOK_ROW_TIMEOUT_MS)
  }

  const runHook = (extra: Record<string, string>): { status: number | null; out: string; elapsedS: number; tailS: number | null; timedOut: boolean } => {
    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^(PREPUSH_|TG_PREPUSH_|STUB_)/.test(k) && !(extra.PATH !== undefined && /^path$/i.test(k))) env[k] = v
    }
    Object.assign(env, {
      PREPUSH_HARD_STOP_S: String(HOOK_STOP_S),
      PREPUSH_POST_STOP_S: String(POST_STOP_S),
      TG_PREPUSH_WSL: '0',
      PREPUSH_FAILED_STORE: slash(path.join(dir, 'store', 'last-failed.json')),
      TMPDIR: slash(path.join(dir, 'tmp')),
      STUB_DIR: slash(stubs),
      ...extra,
    })
    mkdirSync(path.join(dir, 'tmp'), { recursive: true })
    const started = Date.now()
    // Output goes to a file, not a pipe: spawnSync on a pipe waits for every process that inherited it, so a stray survivor would turn the hook's own return time into a timeout; the file measures the hook's own exit.
    const outFile = path.join(dir, 'hook.out')
    const outFd = openSync(outFile, 'w')
    const r = spawnSync(GIT_BASH, [slash(path.join(dir, '.lefthook-scripts', 'run-all-checks.sh'))], { cwd: dir, env, stdio: ['ignore', outFd, outFd], timeout: HOOK_ROW_TIMEOUT_MS })
    closeSync(outFd)
    const ended = Date.now()
    if (r.error) leftLegs = true
    const firedFile = path.join(stubs, 'fired.epoch')
    const tailS = existsSync(firedFile) ? ended / 1000 - Number(readFileSync(firedFile, 'utf8').trim()) : null
    // With no fired.epoch the tail is unknown: lead the output with that and the stubs listing, so a failing row shows what the stubs did; prepended so the legs line stays last.
    const noTail = tailS === null ? `fired.epoch absent; stubs dir: ${readdirSync(stubs).join(', ')}\n` : ''
    return { status: r.status, out: noTail + readFileSync(outFile, 'utf8'), elapsedS: (ended - started) / 1000, tailS, timedOut: r.error !== undefined }
  }

  hookRow('a run with no leg past the stop passes, prints no stop notice and ends with the legs line', () => {
    const r = runHook({})
    expect(r.timedOut).toBe(false)
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('stopped the')
    // The legs line is the hook's last output, so its total= covers every step; only bash start-up and exit lie outside that clock.
    const lines = r.out.trimEnd().split('\n')
    const m = /^pre-push: legs: .* total=(\d+)s$/.exec(lines[lines.length - 1] ?? '')
    expect(m, r.out).not.toBeNull()
    expect(r.elapsedS - Number(m?.[1])).toBeLessThan(SPAWN_SLACK_S)
  })

  hookRow('a stopped test leg is ended at the stop, and the push still passes', () => {
    const r = runHook({ STUB_FIRE_STOP: 'tests', STUB_TESTS_S: '60' })
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain('stopped the win leg after')
    expect(r.out).toMatch(/win=aborted/)
    expect(r.status, r.out).toBe(0)
  })

  hookRow('a stopped typecheck fails the push', () => {
    const r = runHook({ STUB_FIRE_STOP: 'tests', STUB_TYPECHECK_S: '60' })
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain(`typecheck was still running at the ${HOOK_STOP_S}s hard stop`)
    expect(r.status, r.out).toBe(1)
  })

  hookRow('a stopped lint fails the push', () => {
    const r = runHook({ STUB_FIRE_STOP: 'tests', STUB_TS_CHECKS_S: '60' })
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain(`lint was still running at the ${HOOK_STOP_S}s hard stop`)
    expect(r.status, r.out).toBe(1)
  })

  // A parallel WSL leg is not in the first wait; its stub ignores TERM, so only the TERM wait and the tree kill end it. It fires the stop, so it is running when the stop comes.
  hookRow('a parallel WSL leg started before the stop is ended by it, even when it ignores TERM', () => {
    const r = runHook({ PREPUSH_PARALLEL_WSL: '1', TG_PREPUSH_WSL: '1', STUB_FIRE_STOP: 'wsl-test', STUB_TYPECHECK_S: '60', STUB_WSL_S: '50' })
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain('stopped the wsl leg after')
    expect(r.out).toMatch(/wsl=aborted/)
    expect(r.status, r.out).toBe(1)
  })

  // Windows only: a taskkill stub on PATH ends nothing, so each stopped leg survives its kill. The hook must report them by pid and return at the allowance.
  hookRow('a leg that survives its kill does not hold the hook past the post-stop allowance', () => {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'taskkill'), '#!/usr/bin/env bash\nexit 0\n')
    const r = runHook({ STUB_FIRE_STOP: 'tests', STUB_TESTS_S: '60', PATH: `${slash(bin)};${process.env.PATH ?? ''}` })
    // The stopped leg is alive by design here, so the afterEach ends it by its recorded pid.
    leftLegs = true
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain(`still running ${POST_STOP_S}s after the hard stop, not waited on (name=pid):`)
  }, true)

  // Windows only: a native taskkill stub (a copy of node.exe named taskkill.exe whose preload records its pid and never returns) outlasts the 2 s kill window, so cap_kill_all ends the kill job; the native stub, a child of that job and not ended by the job's death, must be ended with it. Inert unless the dir is first on PATH and NODE_OPTIONS names the preload, which only acts inside a process named taskkill.exe.
  hookRow('a taskkill that hangs past the kill window does not outlive the hook', () => {
    const bin = path.join(dir, 'hangbin')
    mkdirSync(bin)
    copyFileSync(process.execPath, path.join(bin, 'taskkill.exe'))
    const preload = path.join(dir, 'hang-taskkill.cjs')
    writeFileSync(preload, "if (/taskkill\\.exe$/i.test(process.execPath)) { require('node:fs').appendFileSync(process.env.STUB_DIR + '/hung-taskkill.pids', process.pid + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000) }\n")
    const pidFile = path.join(stubs, 'hung-taskkill.pids')
    try {
      const r = runHook({ STUB_FIRE_STOP: 'tests', STUB_TESTS_S: '60', PATH: `${slash(bin)}${path.delimiter}${process.env.PATH ?? ''}`, NODE_OPTIONS: `--require ${slash(preload)}` })
      // The legs survive the stub kills by design, so the afterEach ends them by their recorded pids.
      leftLegs = true
      expect(existsSync(pidFile), r.out).toBe(true)
      expect(r.tailS, r.out).not.toBeNull()
      expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
      const pids = readFileSync(pidFile, 'utf8')
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((p) => Number.isInteger(p) && p > 0)
      const stillUp = (): number[] =>
        pids.filter((p) => {
          try {
            process.kill(p, 0)
            return true
          } catch {
            return false
          }
        })
      // Windows tears a killed process down asynchronously, so a 5 s poll tells that from the 300 s hang.
      let alive = stillUp()
      for (let i = 0; i < 25 && alive.length > 0; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
        alive = stillUp()
      }
      expect(alive, `hung taskkill stubs still running after the hook exited\n${r.out}`).toEqual([])
    } finally {
      // Every stub tree is ended here on every path, whether or not the hook ended it.
      if (existsSync(pidFile)) {
        for (const l of readFileSync(pidFile, 'utf8').split('\n')) {
          const p = Number(l.trim())
          if (Number.isInteger(p) && p > 0) killIfCommandLine(p, (commandLine) => /taskkill\.exe/i.test(commandLine), { tree: true })
        }
      }
    }
  }, true)

  // The seam for the two rows below is a node stub first on PATH (the hook runs node by name): it hangs only the duration-record call (test-durations.mjs --record) and passes every other call to the real node, so the hook's own fork is what stalls. It records its pid so the afterEach can end a hang the hook failed to end.
  const hangingNode = (fires: boolean, gatedKill = false): Record<string, string> => {
    const bin = path.join(dir, 'nodebin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'node'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *test-durations.mjs*--record*)',
        '    echo "$(cat /proc/$$/winpid 2>/dev/null || echo $$)" >"$STUB_DIR/hung.pid"',
        '    if [[ "$STUB_NODE_FIRE" == "1" ]]; then',
        '      printf "%s\\n" "$EPOCHREALTIME" >"$STUB_DIR/fired.epoch"',
        '      kill -USR1 "$(cat "$TMPDIR"/token-goat-pre-push.*/hard-stop.pid)"',
        '    fi',
        '    : >"$STUB_DIR/real-kill"',
        `    sleep ${HANG_S}`,
        '    exit 0 ;;',
        'esac',
        'exec "$REAL_NODE" "$@"',
        '',
      ].join('\n'),
    )
    // A gated taskkill ends nothing until the hung node stub has started (the file real-kill), so the stop's own kill leaves the legs alive and only the later kills end them.
    if (gatedKill) {
      writeFileSync(path.join(bin, 'taskkill'), ['#!/usr/bin/env bash', 'if [[ -e "$STUB_DIR/real-kill" ]]; then exec /c/Windows/System32/taskkill.exe "$@"; fi', 'exit 0', ''].join('\n'))
    }
    return { PATH: `${slash(bin)}${path.delimiter}${process.env.PATH ?? ''}`, REAL_NODE: slash(process.execPath), STUB_NODE_FIRE: fires ? '1' : '0' }
  }

  // Windows only: every taskkill hangs, so no tree kill can end the stopped leg inside any kill window; the hook must still end the leg itself (kill -KILL, no taskkill), confirm it, and return inside the tail bound with the leg gone.
  hookRow('a leg whose every taskkill hangs is ended directly and does not outlive the hook', () => {
    const bin = path.join(dir, 'hangbin')
    mkdirSync(bin)
    copyFileSync(process.execPath, path.join(bin, 'taskkill.exe'))
    const preload = path.join(dir, 'hang-taskkill.cjs')
    writeFileSync(preload, "if (/taskkill\\.exe$/i.test(process.execPath)) { require('node:fs').appendFileSync(process.env.STUB_DIR + '/hung-taskkill.pids', process.pid + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000) }\n")
    const pidFile = path.join(stubs, 'hung-taskkill.pids')
    const legUp = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      const r = runHook({ STUB_FIRE_STOP: 'tests', STUB_TESTS_S: '60', PATH: `${slash(bin)}${path.delimiter}${process.env.PATH ?? ''}`, NODE_OPTIONS: `--require ${slash(preload)}` })
      leftLegs = true
      expect(r.timedOut, r.out).toBe(false)
      expect(r.tailS, r.out).not.toBeNull()
      expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
      const pid = Number(readFileSync(path.join(stubs, 'tests.pid'), 'utf8').trim())
      expect(Number.isInteger(pid)).toBe(true)
      // Windows tears a killed process down asynchronously, so a 5 s poll tells that from the 60 s sleep.
      for (let i = 0; i < 25 && legUp(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
      expect(legUp(pid), `tests leg ${pid} outlived the hook\n${r.out}`).toBe(false)
    } finally {
      // Every hung taskkill tree is ended here on every path; the leg is ended by its recorded pid in the afterEach.
      if (existsSync(pidFile)) {
        for (const l of readFileSync(pidFile, 'utf8').split('\n')) {
          const p = Number(l.trim())
          if (Number.isInteger(p) && p > 0) killIfCommandLine(p, (commandLine) => /taskkill\.exe/i.test(commandLine), { tree: true })
        }
      }
    }
  }, true)

  // The Windows pid of the cleanup process, from the first line of its record beside the failed-store.
  const reaperWinpid = (): number => {
    const record = path.join(dir, 'store', 'reaper-last.txt')
    const m = existsSync(record) ? /^reaper: pid=\d+ winpid=(\d+)/m.exec(readFileSync(record, 'utf8')) : null
    return m === null ? 0 : Number(m[1])
  }
  const goneWithin = (pid: number, limitS: number): boolean => {
    const until = Date.now() + limitS * 1000
    const up = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    while (up() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    return !up()
  }
  // A leg stub that registers its pid, starts an msys child, then kills the hook itself with -KILL (no exit trap runs): only the cleanup process, which outlives the hook, can end what the hook left.
  hookRow('a hook killed outright leaves no leg and no cleanup process behind', () => {
    writeFileSync(
      path.join(dir, '.lefthook-scripts', 'run-test.sh'),
      [
        '#!/usr/bin/env bash',
        'echo "$(cat /proc/$$/winpid 2>/dev/null || echo $$)" >"$STUB_DIR/tests.pid"',
        'sleep 90 9<&- &',
        'echo "$(cat /proc/$!/winpid 2>/dev/null || echo $!)" >"$STUB_DIR/tests-child.pid"',
        'kill -KILL "$PPID"',
        'sleep 90',
        '',
      ].join('\n'),
    )
    const r = runHook({})
    leftLegs = true
    const pids = ['tests.pid', 'tests-child.pid'].map((n) => Number(readFileSync(path.join(stubs, n), 'utf8').trim()))
    for (const pid of pids) expect(goneWithin(pid, REAP_GRACE_S + 5), `leg process ${pid} outlived the hook\n${r.out}`).toBe(true)
    const reaper = reaperWinpid()
    expect(reaper, `no cleanup process record\n${r.out}`).toBeGreaterThan(1)
    expect(goneWithin(reaper, REAP_GRACE_S + 5), `the cleanup process ${reaper} outlived the hook`).toBe(true)
  })

  // Windows only: the stopped leg cannot be ended (kill is shadowed through BASH_ENV so a -KILL of the leg's pid does nothing, and taskkill is a stub), so the hook exits with it still alive and must say which, where the record will name it; the cleanup process then records it as left running and exits by its deadline.
  hookRow('a leg still dying at the hook exit is named with the path of the cleanup record', () => {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'taskkill'), '#!/usr/bin/env bash\nexit 0\n')
    const shadow = path.join(dir, 'kill-shadow.sh')
    writeFileSync(shadow, ['kill() {', '  local a m=""', '  if [[ -r "$STUB_DIR/unkillable" ]]; then read -r m <"$STUB_DIR/unkillable" || true; fi', '  for a in "$@"; do', '    if [[ -n "$m" && "$a" == "$m" && "$*" == *-KILL* ]]; then return 0; fi', '  done', '  builtin kill "$@"', '}', ''].join('\n'))
    writeFileSync(
      path.join(dir, '.lefthook-scripts', 'run-test.sh'),
      [
        '#!/usr/bin/env bash',
        'echo "$(cat /proc/$$/winpid 2>/dev/null || echo $$)" >"$STUB_DIR/tests.pid"',
        'echo $$ >"$STUB_DIR/unkillable"',
        'printf "%s\\n" "$EPOCHREALTIME" >"$STUB_DIR/fired.epoch"',
        'kill -TERM "$(cat "$TMPDIR"/token-goat-pre-push.*/hard-stop.pid)"',
        // A loop, not a last `sleep`: the cleanup process ends the sleep child (only the leg's own pid is shadowed), and a script whose last command was that sleep would then end by itself, so the leg would be truly gone and "ended" would be the right record.
        'while (( SECONDS < 600 )); do sleep 150; done',
        '',
      ].join('\n'),
    )
    const r = runHook({ BASH_ENV: slash(shadow), PATH: `${slash(bin)}${path.delimiter}${process.env.PATH ?? ''}` })
    leftLegs = true
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    const record = slash(path.join(dir, 'store', 'reaper-last.txt'))
    expect(r.out).toContain(`records any it cannot end in ${record}`)
    expect(r.out).toContain('CI runs the full suite on pushes to main and on pull requests')
    const reaper = reaperWinpid()
    expect(reaper, `no cleanup process record\n${r.out}`).toBeGreaterThan(1)
    expect(goneWithin(reaper, REAP_GRACE_S + 10), `the cleanup process ${reaper} outlived its deadline`).toBe(true)
    const pid = readFileSync(path.join(dir, 'store', 'reaper-last.txt'), 'utf8')
    expect(pid).toContain(`left running: ${readFileSync(path.join(stubs, 'unkillable'), 'utf8').trim()}`)
  }, true)

  // R4: a fork that starts inside the tail and hangs (the duration record of the Windows leg, which finished before the stop) is ended at the tail deadline, so the hook returns inside the tail bound instead of waiting out the whole hang.
  hookRow('a fork that hangs inside the tail is ended at the tail deadline', () => {
    const r = runHook({ STUB_FIRE_STOP: 'typecheck', STUB_FIRE_AFTER_TESTS: '1', STUB_TYPECHECK_S: '60', ...hangingNode(false) })
    leftHung = true
    // The tail bound is asserted first: a hook that did not return in time reaches the spawn timeout, which would otherwise hide as a timeout.
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.timedOut, r.out).toBe(false)
    expect(r.out).toContain("the hard stop left no time for 'node'")
    // The bounded calls after the tail closed fork nothing: each says so, and none reaches the kill poll.
    expect(r.out, 'a bounded call after the tail closed was not skipped').toMatch(/no time left after the hard stop, so '.+' was skipped/)
  })

  // A leg that survives the stop's own kill is still alive when the tail deadline has passed (the hung fork above runs it out), so the exit trap's kill runs with a deadline already past and must still end the leg and its tree.
  hookRow('a leg that survives the stop is ended by the exit trap after the tail deadline has passed', () => {
    const r = runHook({ STUB_FIRE_STOP: 'typecheck', STUB_FIRE_AFTER_TESTS: '1', STUB_TYPECHECK_S: '60', ...hangingNode(false, true) })
    leftHung = true
    leftLegs = true
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain("the hard stop left no time for 'node'")
    const pid = Number(readFileSync(path.join(stubs, 'typecheck.pid'), 'utf8').trim())
    expect(Number.isInteger(pid)).toBe(true)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive, `typecheck leg ${pid} outlived the hook\n${r.out}`).toBe(false)
  }, true)

  // R3: a fork that hangs before any stop is ended by the stop; the stub fires the stop (USR1 makes the watchdog write the flag, as the clock would) from inside the hung call.
  hookRow('a fork that hangs before the stop is ended when the stop fires', () => {
    const r = runHook(hangingNode(true))
    leftHung = true
    expect(r.timedOut, r.out).toBe(false)
    expect(r.tailS, r.out).not.toBeNull()
    expect(r.tailS, r.out).toBeLessThan(TAIL_BOUND_S)
    expect(r.out).toContain("the hard stop left no time for 'node'")
  })
})

// Ends the process tree of each pid a test recorded in a pid file. A pid is ended only while its command line, read right now, is a bash, so a reused pid is left alone; the tree goes with it, since a plain kill leaves the children behind on Windows.
function endRecordedTrees(pidFiles: string[]): void {
  for (const file of pidFiles) {
    if (!existsSync(file)) continue
    const pid = Number(readFileSync(file, 'utf8').trim())
    if (!Number.isInteger(pid)) continue
    killIfCommandLine(pid, (commandLine) => /bash/i.test(commandLine), { tree: true })
  }
}
