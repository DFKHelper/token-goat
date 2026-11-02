/** The pre-push cleanup process (.lefthook-scripts/prepush-reaper.sh), run for real from a small driver that sources prepush-cap.sh, registers a leg and exits as the hook does: the leg and its tree must be ended within REAP_GRACE_S of the hook's exit even where taskkill leaves a child or hangs, a process it cannot end must be named in the record, and the cleanup process itself must be gone. */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { queryProcessCommandLine } from '../src/resident_process.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'

const GIT_BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const CAP_SCRIPT = fileURLToPath(new URL('../.lefthook-scripts/prepush-cap.sh', import.meta.url))
const REAPER_SCRIPT = fileURLToPath(new URL('../.lefthook-scripts/prepush-reaper.sh', import.meta.url))
const REPO = fileURLToPath(new URL('..', import.meta.url))
const slash = (p: string): string => p.replace(/\\/g, '/')
const bashAvailable = process.platform !== 'win32' || existsSync(GIT_BASH)
// Bound on the driver: it starts the cleanup process (5 one-second ticks at most), waits up to 30 ticks for its leg and up to 60 more for a record line, and every fork costs seconds on a loaded host.
const SPAWN_TIMEOUT_MS = 240_000
// How long after the hook's exit the cleanup process may keep ending legs; read from the script so a change to the constant cannot pass unnoticed.
const REAP_GRACE_S = ((): number => {
  const n = Number(/^REAP_GRACE_S=(\d+)$/m.exec(readFileSync(CAP_SCRIPT, 'utf8'))?.[1])
  if (!Number.isInteger(n)) throw new Error('REAP_GRACE_S=<seconds> was not found in prepush-cap.sh')
  return n
})()
// The cleanup process's own exit lies this far past the last leg it ends: its confirm ticks and the removal of its directory.
const REAP_EXIT_SLACK_S = 5

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
/** True when the process is gone within `limitS` seconds of now, polling its pid; a process Windows is still tearing down counts as alive. */
const goneWithin = (pid: number, limitS: number): boolean => {
  const until = Date.now() + limitS * 1000
  while (alive(pid) && Date.now() < until) pause(200)
  return !alive(pid)
}

/** True when `pid` is gone within `limitS` seconds, or answers with a command line that `isOurs` rejects: a freed Windows pid is handed to the next process started, so on a busy host a pid-only probe sees a stranger and reports our process still running. An unreadable command line counts as alive. */
const ourProcessGoneWithin = (pid: number, isOurs: (commandLine: string) => boolean, limitS: number): boolean => {
  const running = (): boolean => {
    if (!alive(pid)) return false
    const q = queryProcessCommandLine(pid)
    if (q.status === 'gone') return false
    return q.status === 'failed' || isOurs(q.commandLine)
  }
  const until = Date.now() + limitS * 1000
  while (running() && Date.now() < until) pause(200)
  return !running()
}

// A row's own bound: the driver's spawn bound plus three waits of the cleanup process's grace and exit slack (the leg, its tree, the cleanup process); a row with no leg past the hook takes a fraction of it.
const ROW_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 3 * (REAP_GRACE_S + 2 * REAP_EXIT_SLACK_S) * 1000

describe('the pre-push cleanup process', { timeout: ROW_TIMEOUT_MS }, () => {
  let dir = ''
  let tag = ''
  // Every process a row may leave behind: its pid and the command-line pattern that proves it is ours.
  let tracked: Array<{ pid: number; ours: RegExp }> = []

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-prepush-reaper-'))
    mkdirSync(path.join(dir, 'tmp'))
    mkdirSync(path.join(dir, 'log'))
    tag = String(Math.floor(Math.random() * 900000) + 100000)
    tracked = []
  })
  afterEach(() => {
    try {
      for (const t of tracked) if (t.pid > 1) killIfCommandLine(t.pid, (c) => t.ours.test(c), { tree: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // A row whose cleanup ended the runner shows up as a vitest run that exits 0 with no summary; this names the row instead, while the worker still lives to say so.
    expect(alive(process.ppid), `the vitest runner (pid ${process.ppid}) was ended during this row`).toBe(true)
  })

  const file =(name: string): string => path.join(dir, name)
  const num = (name: string): number => Number(readFileSync(file(name), 'utf8').trim())
  const record = (): string => (existsSync(file('store/reaper-last.txt')) ? readFileSync(file('store/reaper-last.txt'), 'utf8') : '')
  // A seconds stamp the cleanup process wrote on its own clock ("hook gone: 41", "exit: 53"), or null when the record has none.
  const stamp = (name: string): number | null => {
    const m = new RegExp(`^${name}: (\\d+)$`, 'm').exec(record())
    return m === null ? null : Number(m[1])
  }

  // The leg: records its pid and the pid of an msys `sleep` it starts as a child (with its Windows pids where /proc has them), then waits; with LEG_HOLD_S it holds that long and exits on its own, leaving the sleep an orphan.
  const writeLeg = (): void => {
    writeFileSync(
      file('leg.sh'),
      [
        '#!/usr/bin/env bash',
        'w=$$; if [[ -r "/proc/$$/winpid" ]]; then read -r w <"/proc/$$/winpid"; fi',
        'echo "$w" >"$D/leg.winpid"',
        `sleep 300.${tag} 9<&- &`,
        's=$!',
        // A forked msys process takes a new Windows pid when it execs sleep, so the pid is read once /proc names sleep as the image.
        'en=""; n=0; while [[ "$en" != *sleep* ]] && (( n < 100 )); do if [[ -r "/proc/$s/exename" ]]; then read -r en <"/proc/$s/exename" || true; else en=sleep; fi; if [[ "$en" != *sleep* ]]; then sleep 0.2; fi; n=$((n + 1)); done',
        'sw=$s; if [[ -r "/proc/$s/winpid" ]]; then read -r sw <"/proc/$s/winpid"; fi',
        'echo "$sw" >"$D/sleep.winpid"',
        'echo "$s" >"$D/sleep.pid"',
        'if [[ -n "${LEG_HOLD_S:-}" ]]; then until [[ -e "$D/release" ]]; do sleep 1; done; exit 0; fi',
        'wait',
        '',
      ].join('\n'),
    )
  }

  // Runs one driver: it sources the cap, starts the leg through cap_register, waits until the leg's sleep exists, runs `extra`, writes the cleanup process's Windows pid and returns, which is the hook's exit. Returns once the driver has exited.
  const runDriver = (extra: string[], env: Record<string, string> = {}, graceS?: number, status = 0): void => {
    writeLeg()
    const lines = [
      'export D="$DRIVER_DIR"',
      'ROOT_DIR="$DRIVER_ROOT"',
      'LOG_DIR="$D/log"',
      'FAILED_STORE="$D/store/last-failed.json"',
      'PIDS=()',
      'HARD_FLAG=""',
      `source "${slash(CAP_SCRIPT)}"`,
      ...(graceS === undefined ? [] : [`REAP_GRACE_S=${graceS}`]),
      // A stub directory holding its own prepush-reaper.sh stands in for the cleanup process the cap starts.
      'if [[ -n "${STUB_REAPER_DIR:-}" ]]; then CAP_SELF_DIR="$STUB_REAPER_DIR"; fi',
      // A stub directory is put first on the PATH in the POSIX form: a Windows PATH list handed to Git Bash is not reliably searched in order.
      'if [[ -n "${STUB_BIN:-}" ]]; then if command -v cygpath >/dev/null 2>&1; then STUB_BIN=$(cygpath -u "$STUB_BIN"); fi; PATH="$STUB_BIN:$PATH"; fi',
      // The hook starts no leg before the cleanup process is up, so the driver starts it first too.
      'cap_reaper_start',
      '"$BASH" "$D/leg.sh" 9<&- &',
      'LEG=$!',
      'PIDS+=("$LEG")',
      'cap_register "$LEG"',
      't=0; until [[ -s "$D/sleep.pid" ]] || (( t >= 30 )); do cap_tick; t=$((t + 1)); done',
      ...extra,
      'w=$REAP_PID; if [[ -r "/proc/$REAP_PID/winpid" ]]; then read -r w <"/proc/$REAP_PID/winpid"; fi',
      'echo "$w" >"$D/reaper.winpid"',
      'echo "$LEG" >"$D/leg.pid"',
      '',
    ]
    writeFileSync(file('driver.sh'), lines.join('\n'))
    const out = openSync(file('driver.out'), 'w')
    const r = spawnSync(GIT_BASH, [slash(file('driver.sh'))], {
      env: { ...process.env, DRIVER_DIR: slash(dir), DRIVER_ROOT: slash(REPO), TMPDIR: slash(file('tmp')), ...env },
      stdio: ['ignore', out, out],
      timeout: SPAWN_TIMEOUT_MS,
    })
    closeSync(out)
    const said = readFileSync(file('driver.out'), 'utf8')
    // Registered before the driver could fail, so the afterEach ends them even when the driver did not return.
    for (const n of ['leg.winpid', 'sleep.winpid', 'reaper.winpid']) {
      if (existsSync(file(n))) tracked.push({ pid: num(n), ours: n === 'reaper.winpid' ? /prepush-reaper/ : n === 'sleep.winpid' ? new RegExp(`sleep 300\\.${tag}`) : /leg\.sh/ })
    }
    expect(r.error, said).toBeUndefined()
    expect(r.status, said).toBe(status)
  }

  // A cleanup process stand-in: it waits delayS seconds before it runs the real one (which writes `up`), or exits at once when delayS is empty.
  const writeStubReaper = (delayS: number | null): string => {
    const stub = file('stub-reaper')
    mkdirSync(stub)
    const body = delayS === null ? ['exit 3'] : [`sleep ${delayS}`, `exec "$BASH" "${slash(REAPER_SCRIPT)}" "$@"`]
    writeFileSync(path.join(stub, 'prepush-reaper.sh'), ['#!/usr/bin/env bash', ...body, ''].join('\n'))
    return slash(stub)
  }

  // The cleanup process writes `up` only after more than the old fixed 5 s wait: the hook waits for the event, runs its leg and returns. The elapsed time proves the wait outlasted 5 s.
  it.skipIf(!bashAvailable)('waits for a cleanup process that is slow to say it is up, and still runs the leg', () => {
    const t0 = Date.now()
    runDriver([], { STUB_REAPER_DIR: writeStubReaper(8) })
    expect((Date.now() - t0) / 1000, 'the stub did not take longer than the old 5 s wait, so the row proves nothing').toBeGreaterThan(5)
    expect(existsSync(file('leg.winpid')), 'the leg never ran').toBe(true)
    expect(readFileSync(file('driver.out'), 'utf8')).not.toContain('cleanup process')
  })

  // The cleanup process exits before it writes `up`: the push fails at once with a notice that says so, and no leg starts.
  it.skipIf(!bashAvailable)('fails the push with a notice when the cleanup process exits before it is up', () => {
    runDriver([], { STUB_REAPER_DIR: writeStubReaper(null) }, undefined, 1)
    expect(readFileSync(file('driver.out'), 'utf8')).toContain('the cleanup process exited before it started')
    expect(existsSync(file('leg.winpid')), 'a leg started with no cleanup process running').toBe(false)
  })

  it.skipIf(!bashAvailable)('ends a leg and its tree within the grace after the hook exits, and exits itself', () => {
    runDriver([])
    const t0 = Date.now()
    expect(goneWithin(num('leg.winpid'), REAP_GRACE_S), `leg outlived the hook by more than ${REAP_GRACE_S}s`).toBe(true)
    expect(goneWithin(num('sleep.winpid'), REAP_GRACE_S), 'the leg tree outlived the hook').toBe(true)
    expect(goneWithin(num('reaper.winpid'), REAP_GRACE_S + REAP_EXIT_SLACK_S), 'the cleanup process is still running').toBe(true)
    expect((Date.now() - t0) / 1000).toBeLessThan(REAP_GRACE_S + REAP_EXIT_SLACK_S)
    expect(record()).toContain(`ended: ${num('leg.pid')}`)
    expect(record()).not.toContain('left running')
    expect(readdirSync(file('tmp')).filter((n) => n.startsWith('tg-reap.'))).toEqual([])
  })

  // taskkill /T ends the leg's bash and its native children but leaves an msys child (the sleep): the cleanup process finds that child before the leg dies and ends it directly.
  it.skipIf(!bashAvailable)('ends an msys child that taskkill leaves behind', () => {
    runDriver([])
    expect(goneWithin(num('sleep.winpid'), REAP_GRACE_S), 'the sleep under the leg outlived the hook').toBe(true)
    expect(goneWithin(num('reaper.winpid'), REAP_GRACE_S + REAP_EXIT_SLACK_S)).toBe(true)
    expect(record()).toContain(`ended: ${num('sleep.pid')}`)
  })

  // The leg exits on its own while the hook is still running and leaves its sleep orphaned, with no parent to find it by: the leg is released only after the record shows the cleanup process tracking the sleep, then it ends the sleep when the hook is gone.
  it.skipIf(!bashAvailable)('ends an orphan whose leg exited before the hook did', () => {
    runDriver(['s=$(<"$D/sleep.pid"); t=0', 'until [[ -r "$D/store/reaper-last.txt" && "$(<"$D/store/reaper-last.txt")" == *"tracking: $s "* ]] || (( t >= 60 )); do cap_tick; t=$((t + 1)); done', ': >"$D/release"', 'wait "$LEG" || true'], { LEG_HOLD_S: '1' })
    expect(goneWithin(num('sleep.winpid'), REAP_GRACE_S), 'the orphaned sleep outlived the hook').toBe(true)
    expect(goneWithin(num('reaper.winpid'), REAP_GRACE_S + REAP_EXIT_SLACK_S)).toBe(true)
    expect(record()).toContain(`ended: ${num('sleep.pid')}`)
  })

  // Every taskkill hangs: a bash stub that writes its Windows pid to hung-taskkill.pids at once, then sleeps. The pid is written before anything can wait on it, so a row reads the file after an event it owns (the cleanup process's exit, the leg's end), never after a poll for the file.
  const writeHangTaskkill = (): string => {
    const bin = file('hangbin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'taskkill'),
      ['#!/usr/bin/env bash', 'w=$$; if [[ -r "/proc/$$/winpid" ]]; then read -r w <"/proc/$$/winpid"; fi', 'echo "$w" >>"$DRIVER_DIR/hung-taskkill.pids"', `sleep 300.${tag} 9<&-`, ''].join('\n'),
    )
    return slash(bin)
  }
  const hungTaskkillPids = (): number[] =>
    existsSync(file('hung-taskkill.pids'))
      ? readFileSync(file('hung-taskkill.pids'), 'utf8')
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((p) => Number.isInteger(p) && p > 1)
      : []
  const trackHungTaskkills = (): void => {
    for (const pid of hungTaskkillPids()) tracked.push({ pid, ours: /taskkill/i })
  }

  // Windows only: every taskkill hangs, so no tree kill ends anything inside its window; the cleanup process cuts each at the kill window, ends the tree itself, and leaves no taskkill behind. The cleanup process's exit is the event after which the stub's record is complete.
  it.skipIf(process.platform !== 'win32' || !bashAvailable)('ends a leg whose every taskkill hangs, and leaves no taskkill running', () => {
    try {
      runDriver([], { STUB_BIN: writeHangTaskkill() })
    } finally {
      // Every hung taskkill tree is ended on every path, whether or not the cleanup process ended it.
      trackHungTaskkills()
    }
    expect(goneWithin(num('reaper.winpid'), REAP_GRACE_S + 2 * REAP_EXIT_SLACK_S), 'the cleanup process is still running').toBe(true)
    trackHungTaskkills()
    expect(hungTaskkillPids().length, 'taskkill was never run').toBeGreaterThan(0)
    expect(goneWithin(num('leg.winpid'), REAP_GRACE_S), 'the leg outlived the hook').toBe(true)
    expect(goneWithin(num('sleep.winpid'), REAP_GRACE_S), 'the leg tree outlived the hook').toBe(true)
    for (const p of hungTaskkillPids()) expect(ourProcessGoneWithin(p, (c) => /taskkill/i.test(c), REAP_GRACE_S), `hung taskkill ${p} is still running\n${record()}\n${readFileSync(file('hung-taskkill.pids'), 'utf8')}`).toBe(true)
  })

  // The hook is still running when a leg is asked for and every taskkill hangs: the cleanup process ends the leg directly when the kill window is over, not only after the hook has gone. A gate on the hook being gone left such a leg alive for the hook's whole tail (41.7 s after the stop in a stamped run), so a short stub leg ended on its own first. The driver stands for the hook: it asks, then polls for 25 ticks, and records whether the leg was gone while it was still the hook.
  it.skipIf(process.platform !== 'win32' || !bashAvailable)('ends a leg whose every taskkill hangs while the hook is still running', () => {
    const asked = ['cap_request_kill "$LEG"', 't=0; until ! kill -0 "$LEG" 2>/dev/null || (( t >= 25 )); do cap_tick; t=$((t + 1)); done', 'if kill -0 "$LEG" 2>/dev/null; then echo alive >"$D/leg.state"; else echo gone >"$D/leg.state"; fi']
    try {
      runDriver(asked, { STUB_BIN: writeHangTaskkill() })
    } finally {
      trackHungTaskkills()
    }
    expect(hungTaskkillPids().length, 'taskkill was never run').toBeGreaterThan(0)
    expect(readFileSync(file('leg.state'), 'utf8').trim(), 'the leg was still alive while the hook ran, 25 s after it was asked for').toBe('gone')
  })

  // A process the cleanup process cannot end is named, not hidden: kill is shadowed in every bash of the run (BASH_ENV) so a -KILL of the marked sleep does nothing, and taskkill is a stub that ends nothing. The record carries `left running: <pid>`, the cleanup process still exits by its deadline, and the afterEach ends the sleep.
  it.skipIf(!bashAvailable)('names a process it cannot end as left running, and exits by its deadline', () => {
    const bin = file('bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'taskkill'), '#!/usr/bin/env bash\nexit 0\n')
    const shadow = file('kill-shadow.sh')
    writeFileSync(
      shadow,
      ['kill() {', '  local a m=""', '  if [[ -r "$DRIVER_DIR/sleep.pid" ]]; then read -r m <"$DRIVER_DIR/sleep.pid" || true; fi', '  for a in "$@"; do', '    if [[ -n "$m" && "$a" == "$m" && "$*" == *-KILL* ]]; then return 0; fi', '  done', '  builtin kill "$@"', '}', ''].join('\n'),
    )
    const graceS = 12
    runDriver([], { BASH_ENV: slash(shadow), STUB_BIN: slash(bin) }, graceS)
    // The cleanup process ends the leg's bash itself; only the shadowed sleep stays.
    expect(goneWithin(num('leg.winpid'), graceS + REAP_EXIT_SLACK_S), 'the leg outlived the hook').toBe(true)
    expect(goneWithin(num('reaper.winpid'), graceS + 2 * REAP_EXIT_SLACK_S), 'the cleanup process outlived its deadline').toBe(true)
    expect(record()).toContain(`left running: ${num('sleep.pid')}`)
    expect(alive(num('sleep.winpid')), 'the shadowed sleep was ended after all, so the row proves nothing').toBe(true)
  })

  // A leg whose own -KILL is shadowed still ends once its only child is ended (its script has nothing left to run), so "ended" is the true record for it and "left running" would be the false one. A smoke row once expected "left running" from such a leg and got "ended" (2026-11-01): the record was right, the stub leg's last command was a child that the cleanup process ended. The record may say "ended" only for a leg that is gone, so the row checks both.
  it.skipIf(!bashAvailable)('records a leg as ended, and it is gone, when ending its child lets it finish', () => {
    const bin = file('bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'taskkill'), '#!/usr/bin/env bash\nexit 0\n')
    const shadow = file('kill-shadow.sh')
    writeFileSync(
      shadow,
      ['kill() {', '  local a m=""', '  if [[ -r "$DRIVER_DIR/leg.pid" ]]; then read -r m <"$DRIVER_DIR/leg.pid" || true; fi', '  for a in "$@"; do', '    if [[ -n "$m" && "$a" == "$m" && "$*" == *-KILL* ]]; then return 0; fi', '  done', '  builtin kill "$@"', '}', ''].join('\n'),
    )
    const graceS = 12
    runDriver([], { BASH_ENV: slash(shadow), STUB_BIN: slash(bin) }, graceS)
    expect(goneWithin(num('reaper.winpid'), graceS + 2 * REAP_EXIT_SLACK_S), 'the cleanup process outlived its deadline').toBe(true)
    expect(goneWithin(num('leg.winpid'), 1), 'the leg is still running, so a record of it as ended would be false').toBe(true)
    expect(record()).toContain(`ended: ${num('leg.pid')}`)
    expect(record()).not.toContain('left running')
  })

  // The grace runs from the hook's death, not from when the cleanup process next looks: it is inside the end of a request (the 5 s kill window and 3 confirm ticks, since the shadowed sleep never dies) when the driver, standing for the hook, exits one tick after asking. The exit was stamped when that request was done, so it came up to 8 s past the grace and a smoke row's deadline (grace + 10 s) was missed once in nine runs (2026-11-01).
  it.skipIf(!bashAvailable)('exits by the grace after the hook is gone even when it was ending a request at that moment', () => {
    const bin = file('bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'taskkill'), '#!/usr/bin/env bash\nexit 0\n')
    const shadow = file('kill-shadow.sh')
    writeFileSync(
      shadow,
      ['kill() {', '  local a m=""', '  if [[ -r "$DRIVER_DIR/sleep.pid" ]]; then read -r m <"$DRIVER_DIR/sleep.pid" || true; fi', '  for a in "$@"; do', '    if [[ -n "$m" && "$a" == "$m" && "$*" == *-KILL* ]]; then return 0; fi', '  done', '  builtin kill "$@"', '}', ''].join('\n'),
    )
    const graceS = 12
    runDriver(['cap_request_kill "$LEG"', 'cap_tick'], { BASH_ENV: slash(shadow), STUB_BIN: slash(bin) }, graceS)
    // The exit is awaited as an event; the grace is then read off the cleanup process's own clock, the stamps it wrote when it first saw the hook gone and when it exited, so host load moves neither.
    expect(goneWithin(num('reaper.winpid'), REAP_GRACE_S + 2 * REAP_EXIT_SLACK_S), 'the cleanup process did not exit').toBe(true)
    const gone = stamp('hook gone')
    const exited = stamp('exit')
    expect(gone, `the record has no hook-gone stamp\n${record()}`).not.toBeNull()
    expect(exited, `the record has no exit stamp\n${record()}`).not.toBeNull()
    expect((exited ?? 0) - (gone ?? 0), 'the cleanup process outlived the grace counted from the hook exit').toBeLessThanOrEqual(graceS)
  })

  // The cleanup process's functions, sourced without its loop (REAP_SOURCE_ONLY) and driven directly, one line of "name=value" output per probe. `winpid_of` is redefined after the source to stand for what /proc answers.
  const runLib = (body: string[]): Record<string, string> => {
    mkdirSync(file('rd'))
    const script = [
      'export REAP_SOURCE_ONLY=1',
      `source "${slash(REAPER_SCRIPT)}" "$$" "$DRIVER_DIR/rd" "$DRIVER_DIR/lib-record.txt" 0 30 5`,
      ...body,
      '',
    ].join('\n')
    writeFileSync(file('lib.sh'), script)
    const out = openSync(file('lib.out'), 'w')
    const r = spawnSync(GIT_BASH, [slash(file('lib.sh'))], { env: { ...process.env, DRIVER_DIR: slash(dir), TMPDIR: slash(file('tmp')) }, stdio: ['ignore', out, out], timeout: SPAWN_TIMEOUT_MS })
    closeSync(out)
    const said = readFileSync(file('lib.out'), 'utf8')
    expect(r.error, said).toBeUndefined()
    expect(r.status, said).toBe(0)
    const got: Record<string, string> = {}
    for (const l of said.split('\n')) {
      const m = /^([a-z_]+)=(.*)$/.exec(l)
      if (m !== null) got[m[1] as string] = m[2] as string
    }
    return got
  }

  // The hook's Windows pid is read at start; a later read that fails leaves it empty. That is "unknown", not "the hook is gone": treating it as gone ends healthy legs and fails the push.
  it.skipIf(!bashAvailable)('keeps the hook alive when its Windows pid cannot be read, and gone when another process answers', () => {
    const got = runLib([
      'winpid_of "$OWNER"; OWNER_W=${W:-111}',
      'winpid_of() { W=$OWNER_W; }',
      'owner_alive && echo same=alive || echo same=gone',
      'winpid_of() { W=""; }',
      'owner_alive && echo unreadable=alive || echo unreadable=gone',
      'winpid_of() { W=999999; }',
      'owner_alive && echo reused=alive || echo reused=gone',
    ])
    expect(got.same, 'the hook with its own Windows pid is gone').toBe('alive')
    expect(got.unreadable, 'an unreadable Windows pid was taken for the hook being gone').toBe('alive')
    expect(got.reused, 'a pid now answered by another process was taken for the hook').toBe('gone')
  })

  // Each bounded call replays its own output file: a shared file let a call that ran nothing replay the previous call's output.
  it.skipIf(!bashAvailable)('gives every bounded call its own output file', () => {
    writeFileSync(
      file('bounded.sh'),
      [
        'D="$DRIVER_DIR"',
        'ROOT_DIR="$DRIVER_ROOT"',
        'LOG_DIR="$D/log"',
        'FAILED_STORE="$D/store/last-failed.json"',
        'PIDS=()',
        'HARD_FLAG=""',
        `source "${slash(CAP_SCRIPT)}"`,
        'cap_bounded echo first',
        'cap_bounded true',
        'w=$REAP_PID; if [[ -r "/proc/$REAP_PID/winpid" ]]; then read -r w <"/proc/$REAP_PID/winpid"; fi',
        'echo "$w" >"$D/reaper.winpid"',
        '',
      ].join('\n'),
    )
    const out = openSync(file('driver.out'), 'w')
    const r = spawnSync(GIT_BASH, [slash(file('bounded.sh'))], { env: { ...process.env, DRIVER_DIR: slash(dir), DRIVER_ROOT: slash(REPO), TMPDIR: slash(file('tmp')) }, stdio: ['ignore', out, out], timeout: SPAWN_TIMEOUT_MS })
    closeSync(out)
    const said = readFileSync(file('driver.out'), 'utf8')
    if (existsSync(file('reaper.winpid'))) tracked.push({ pid: num('reaper.winpid'), ours: /prepush-reaper/ })
    expect(r.status, said).toBe(0)
    expect(said.split('\n').filter((l) => l === 'first')).toHaveLength(1)
    const logs = readdirSync(file('log')).filter((n) => n.startsWith('bounded.'))
    expect(logs.sort()).toEqual(['bounded.1.out', 'bounded.2.out'])
    expect(readFileSync(file('log/bounded.1.out'), 'utf8')).toBe('first\n')
    expect(readFileSync(file('log/bounded.2.out'), 'utf8')).toBe('')
    expect(goneWithin(num('reaper.winpid'), REAP_GRACE_S + REAP_EXIT_SLACK_S), 'the cleanup process is still running').toBe(true)
  })
})
