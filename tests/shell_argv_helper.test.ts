// The shell oracle behind the quoting tests: it must account for every command it was handed, say so when a shell was killed rather than report an empty stderr, and not fork a subshell per command, which under full-suite load took Git Bash past its 120 s cap at 158 of 184 commands. Provenance: HAND-DERIVED. Each expected argv is read off the command text by hand, independently of the helper's parser.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { OWNER_VAR, POSIX_SH, REAP_SCRIPT, SH_LIVE, SH_SCRIPT, reapOwned, shRunAll } from './helpers/shell_argv.js'
import { startWatchdog } from './helpers/stall_proof_watchdog.js'

describe.skipIf(POSIX_SH === null)('shRunAll', () => {
  const sh = POSIX_SH!

  // A builtin wait rather than sleep: a child process would hold the output pipe open after the shell is killed. The shell is ended by the event of the child having started, not by a clock, so a machine slow to start the shell still has the child at its wait when the kill lands.
  it('names the kill when the shell is ended before every command ran', async () => {
    // Killing the outer shell must not orphan the chunk subshell or the process it is waiting on. Provenance: HAND-DERIVED. The child blocks on an event that never comes and marks the moment its wait returns, so the pass condition is that marker staying absent, not a race against a clock.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shargv-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    try {
      const shq = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`
      // The child blocks on a FIFO nobody ever opens for writing, so only the kill can end it: no clock decides the outcome. `reached` is written only if the wait returned. The run's owner token is saved so the finally below can reap the child however the test ends.
      const child = `'echo $$ > "$1"; read -r _ < "$3"; : > "$2"'`
      const loop = `echo "\${BASHPID:-$(exec sh -c 'echo $PPID')}" > ${shq(file('pid'))}; echo "$${OWNER_VAR}" > ${shq(file('token'))}; mkfifo ${shq(file('fifo'))} && "$BASH" -c ${child} tg ${shq(file('kid'))} ${shq(file('reached'))} ${shq(file('fifo'))} < /dev/null > /dev/null 2>&1`
      let message = ''
      try {
        shRunAll(sh, ['token-goat a', loop, 'token-goat b'], { killWhen: () => fs.existsSync(file('kid')) })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/ran 1 of 3 commands: .*SIGTERM/)
      expect(message, message).not.toMatch(/cleanup/)
      const pids = ['pid', 'kid'].map((name) => fs.readFileSync(file(name), 'utf8').trim())
      for (const pid of pids) expect(pid).toMatch(/^[1-9]\d*$/)
      // shRunAll returned without a cleanup failure, so its reap has already waited, by the liveness rule asked here, for everything the run started to end: one check, no polling. The same rule is used because a stricter copy once read an exited MSYS pid as running and failed a cleanup that had succeeded.
      const alive = (): boolean => spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${pids[0]} || tg_live ${pids[1]}`], { windowsHide: true, timeout: 30_000 }).status === 0
      expect(alive(), 'the chunk subshell or its child is still running after the run returned').toBe(false)
      expect(fs.existsSync(file('reached')), 'the child came back from its wait, so nothing killed it').toBe(false)
    } finally {
      // Insurance for a failed assertion: the owner token the run's processes carry, read from the file the loop wrote, ends anything still blocked.
      let token = ''
      try {
        token = fs.readFileSync(file('token'), 'utf8').trim()
      } catch {
        // The loop never ran, so no child exists to reap.
      }
      if (token !== '') reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)

  // Provenance: HAND-DERIVED, from a hand-observed leak of two looping shells whose parent was gone for three days. Under Git Bash a native parent reads as `$PPID` 1, so the shell cannot ask whether its parent lives; its own `TG_BUDGET_S` deadline is what ends it. The launcher is a short-lived node process that starts the real SH_SCRIPT, waits until the shell is looping, and exits without stopping it; the wait is a stall-proof watchdog and the shell is reaped by its owner token in `finally` however the test ends.
  it('exits on its own when the process that launched it is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shorphan-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'orphaned shell did not exit' })
    let launcher: ChildProcess | undefined
    let leftover: string | null
    try {
      // Detached because a Git Bash loop that shares its dead parent's hidden console exits with it, which would make the test pass without the deadline; detached, it survives as a real orphan does.
      fs.writeFileSync(file('launcher.cjs'), [
        "const { spawn } = require('node:child_process')",
        "const fs = require('node:fs')",
        "spawn(process.env.TG_TEST_SH, ['-c', process.env.TG_TEST_SCRIPT], { stdio: 'ignore', windowsHide: true, detached: true })",
        "const wait = setInterval(() => { if (fs.existsSync(process.env.TG_PIDFILE)) { clearInterval(wait); process.exit(0) } }, 50)",
      ].join('\n'))
      launcher = spawn(process.execPath, [file('launcher.cjs')], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, TG_TEST_SH: sh, TG_TEST_SCRIPT: SH_SCRIPT, TG_PIDFILE: file('pid'), TG_N: '1000000000', TG_CHUNK: '16', TG_BUDGET_S: '2', TG_CMD_0: 'echo $$ > "$TG_PIDFILE"', [OWNER_VAR]: token },
      })
      const launcherGone = new Promise<void>((resolve) => launcher!.once('exit', () => { watchdog.progress('launcher exited'); resolve() }))
      await Promise.race([launcherGone, watchdog.failed])
      const pid = fs.readFileSync(file('pid'), 'utf8').trim()
      expect(pid).toMatch(/^[1-9]\d*$/)
      const alive = (): boolean => spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${pid}`], { windowsHide: true, timeout: 30_000 }).status === 0
      const gone = (async (): Promise<void> => {
        while (alive()) await new Promise((resolve) => setTimeout(resolve, 200))
        watchdog.progress('shell gone')
      })()
      await Promise.race([gone, watchdog.failed])
    } finally {
      watchdog.stop()
      if (launcher !== undefined && launcher.exitCode === null) launcher.kill()
      leftover = reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(leftover, 'the cleanup of the test shell failed').toBeNull()
  }, 120_000)

  // The shell must exit on its own with status 1. A shell that loops instead makes no progress, so the stall-proof watchdog fails it after a quiet limit that a slow shell start cannot reach, and the shell is killed in `finally`; a fixed two-second spawn timeout failed this on a busy machine.
  it('exits immediately if TG_CHUNK is missing or non-positive rather than loop forever', async () => {
    for (const chunk of ['', '0', '-1', 'notanumber']) {
      const watchdog = startWatchdog({ quietLimitMs: 30_000, label: `shell did not exit for TG_CHUNK=${JSON.stringify(chunk)}` })
      const child = spawn(sh, ['-c', SH_SCRIPT], { env: { ...process.env, TG_N: '5', TG_CHUNK: chunk }, stdio: 'ignore', windowsHide: true })
      try {
        const status = await Promise.race([
          new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', (code) => { watchdog.progress('shell exited'); resolve(code) })
          }),
          watchdog.failed,
        ])
        expect(status).toBe(1)
      } finally {
        watchdog.stop()
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
    }
  })

  // Provenance: HAND-DERIVED. The reap scans for owned processes, then kills what it found; a process forked after its last scan was never in that set and outlived the reap, which failed the timeout test above under full-suite load. The window is forced by events and no clock: the owned parent blocks until the slowed reap has finished every scan, so its child is born after the last one however slow the host is. The slowed reap runs asynchronously under a stall-proof watchdog fed by its own progress output and by the files it and the parent write, so no spawn timeout decides the outcome.
  it('ends an owned process that was started after the reap stopped scanning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shlate-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const read = (name: string): string => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').trim() : '')
    const patch = (script: string, from: string, to: string): string => {
      expect(script.includes(from), `the reap script no longer has the text this test slows: ${from}`).toBe(true)
      return script.replace(from, () => to)
    }
    // Before its first round the reap waits until the parent is in the set it found, so the parent is always among the processes the kill covers.
    const waitForParent = [
      'tg_pp=',
      'until [ -n "$tg_pp" ] && { if [ -r /proc/self/environ ]; then grep -qzxF -e "$tg_needle" "/proc/$tg_pp/environ" 2>/dev/null; else tg_light=; tg_owned; case " $tg_found " in *" $tg_pp "*) true ;; *) false ;; esac; fi; }; do',
      `  read -r tg_pp 2>/dev/null < "${file('parentpid')}"`,
      '  echo wait',
      '  sleep 0.1',
      'done',
      'for tg_round in 1 2 3 4 5; do',
      '  echo round',
    ].join('\n')
    // After its last scan the reap releases the parent and holds the kill until the late child wrote its pid or the parent is gone.
    const holdKill = [
      SH_LIVE,
      `echo "$tg_all" > "${file('seen')}"`,
      `: > "${file('release')}"`,
      `until [ -s "${file('kid')}" ] || ! tg_live "$tg_pp"; do echo hold; sleep 0.1; done`,
      '[ -z "$tg_all" ] || { kill -KILL',
    ].join('\n')
    const slowed = patch(patch(patch(patch(REAP_SCRIPT, 'kill -STOP $tg_new 2>/dev/null', ':'), 'for tg_round in 1 2 3 4 5; do', waitForParent), '[ -z "$tg_all" ] || { kill -KILL', holdKill), '  tg_left=\n', '  echo drain\n  tg_left=\n')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    // The parent waits for the release file, then starts a child that blocks on a FIFO nobody writes, so only a kill ends it; its own errors land in a file.
    fs.writeFileSync(file('parent.sh'), [
      'exec 2> "$5"',
      'mkfifo "$2"',
      'echo $$ > "$1"',
      'until [ -e "$3" ]; do [ "$SECONDS" -lt 600 ] || exit 1; sleep 0.1; done',
      '"$BASH" -c \'echo $$ > "$1"; read -r _ < "$2"\' tg "$4" "$2" < /dev/null > /dev/null 2>&1',
    ].join('\n'))
    // The quiet limit counts time with neither reap output nor a new file, and a tick delayed by a machine stall counts as one interval, so a slow host does not fail the test; only a reap that stops advancing does.
    const watchdog = startWatchdog({ quietLimitMs: 60_000, label: 'the slowed reap made no progress' })
    const parent = spawn(sh, [file('parent.sh'), file('parentpid'), file('fifo'), file('release'), file('kid'), file('err')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    const reap = spawn(sh, ['-c', slowed], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, TG_REAP_TOKEN: token } })
    let reapErr = ''
    reap.stdout.on('data', () => { watchdog.progress('reap output') })
    reap.stderr.on('data', (chunk: Buffer) => { reapErr += chunk.toString() })
    const reapExit = new Promise<number | null>((resolve, reject) => {
      reap.once('error', reject)
      reap.once('exit', (code) => { watchdog.progress('reap exited'); resolve(code) })
    })
    let watching = true
    const watchFiles = (async (): Promise<void> => {
      let known = 0
      while (watching) {
        const now = ['parentpid', 'release', 'seen', 'kid'].filter((name) => fs.existsSync(file(name))).length
        if (now > known) { known = now; watchdog.progress('a file appeared') }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })()
    const got = { failure: null as string | null, kid: '', parentPid: '', seen: [] as string[], err: '', alive: true }
    try {
      const code = await Promise.race([reapExit, watchdog.failed])
      got.failure = code === 0 ? null : `exit status ${String(code)}; ${reapErr.trim()}`
      got.kid = read('kid')
      got.parentPid = read('parentpid')
      got.seen = read('seen').split(/\s+/)
      got.err = read('err')
      if (/^[1-9]\d*$/.test(got.kid)) got.alive = spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${got.kid}`], { windowsHide: true, timeout: 30_000 }).status === 0
    } finally {
      watching = false
      await watchFiles
      watchdog.stop()
      if (reap.exitCode === null && reap.signalCode === null) reap.kill()
      if (parent.exitCode === null) parent.kill()
      reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.kid, `the late child never started, so the forced window did not happen; the parent said: ${got.err}; the reap said: ${got.failure}`).toMatch(/^[1-9]\d*$/)
    expect(got.seen, 'the reap did not hold the parent when it released it').toContain(got.parentPid)
    expect(got.seen, 'the late child was already in the reap set, so the forced window did not happen').not.toContain(got.kid)
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the chunk subshell or its child is still running after the run returned').toBe(false)
  }, 120_000)

  // Provenance: HAND-DERIVED, from a captured failure under a fork storm: under MSYS a child shows in /proc stat, with its parent and group, one to several seconds before its environment can be read, so a child its parent started just before being killed was invisible to a reap that looks only for the token and outlived it. The window is forced by starting the child with the token removed from its environment, which is what the token scan sees of an uninitialised MSYS child; the owned parent stays alive and blocked, so the reap can end the child only by finding it through its parent.
  it('ends an owned child whose environment does not carry the token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shkin-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'tokenless child never started' })
    fs.writeFileSync(file('parent.sh'), [
      'mkfifo "$2"',
      `env -u ${OWNER_VAR} "$BASH" -c 'echo $$ > "$1"; read -r _ < "$2"' tg "$1" "$2" < /dev/null > /dev/null 2>&1`,
    ].join('\n'))
    const parent = spawn(sh, [file('parent.sh'), file('kid'), file('fifo')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    let kid = ''
    const got = { failure: null as string | null, alive: true }
    try {
      while (!/^[1-9]\d*$/.test(kid)) {
        if (fs.existsSync(file('kid'))) kid = fs.readFileSync(file('kid'), 'utf8').trim()
        if (!/^[1-9]\d*$/.test(kid)) await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), watchdog.failed])
      }
      watchdog.progress('tokenless child running')
      got.failure = reapOwned(sh, token)
      got.alive = spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${kid}`], { windowsHide: true, timeout: 30_000 }).status === 0
    } finally {
      watchdog.stop()
      if (parent.exitCode === null) parent.kill()
      if (/^[1-9]\d*$/.test(kid)) spawnSync(sh, ['-c', `kill -KILL ${kid}`], { windowsHide: true, timeout: 30_000 })
      reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the child that does not carry the token is still running after the reap returned').toBe(false)
  }, 120_000)

  // Provenance: HAND-DERIVED from a captured scan: the grep the reap runs to list every process carrying the token was killed by SIGHUP after four seconds and printed nothing, and the reap read that as no owned process, so it ended with the run's processes still alive. The failure is forced by a `grep` function that dies (status 129, no output) on its first two calls, which are the two scans the old reap counted as clean; the owned parent stays blocked, so only a scan that is repeated finds it. The reap runs asynchronously under the stall-proof watchdog, fed by the scan calls and the files the test waits on.
  // Provenance: HAND-DERIVED from a second capture: a scan that finished with status 2 and no error naming the owned process, which was alive and forking, listed everything but it (1 of 32 scans under load). The case is forced by a `grep` that prints nothing and exits 1 on its first two calls.
  it.skipIf(process.platform === 'darwin').each([
    ['ends an owned process when the scan that lists it is killed before it finishes', 'return 129'],
    ['ends an owned process when the scan that lists it finishes without listing it', 'return 1'],
  ])('%s', async (_name, dies) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shscan-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const read = (name: string): string => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').trim() : '')
    // The call count is the lines appended to a file, read by a builtin loop: a forked reader or a read-modify-write counter lost counts when a fork failed under load.
    const fakeGrep = [
      'grep() {',
      '  tg_n=0',
      `  if [ -r "${file('calls')}" ]; then while read -r _; do tg_n=$((tg_n + 1)); done < "${file('calls')}"; fi`,
      `  echo x >> "${file('calls')}"`,
      `  if [ "$tg_n" -lt 2 ]; then ${dies}; fi`,
      '  command grep "$@"',
      '}',
    ].join('\n')
    // The reap starts scanning only once the parent's environment is readable, so a young MSYS process cannot make the scan miss for a reason this test does not force.
    const waitForParent = [
      'tg_pp=',
      'until [ ! -r /proc/self/environ ] || { [ -n "$tg_pp" ] && command grep -qzxF -e "$tg_needle" "/proc/$tg_pp/environ" 2>/dev/null; }; do',
      `  read -r tg_pp 2>/dev/null < "${file('parentpid')}"`,
      '  sleep 0.1',
      'done',
      'tg_all=',
      'for tg_round in 1 2 3 4 5; do',
    ].join('\n')
    const base = REAP_SCRIPT
    expect(base.includes('tg_all=\nfor tg_round in 1 2 3 4 5; do'), 'the reap script no longer starts its rounds with this text').toBe(true)
    const hold = '[ -z "$tg_all" ] || { kill -KILL'
    expect(base.includes(hold), 'the reap script no longer kills with this text').toBe(true)
    const recorded = base.replace(hold, () => `echo "$tg_all" > "${file('seen')}"\n${hold}`)
    const script = `${fakeGrep}\n${recorded.replace('tg_all=\nfor tg_round in 1 2 3 4 5; do', () => waitForParent)}`
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    fs.writeFileSync(file('parent.sh'), ['mkfifo "$2"', 'echo $$ > "$1"', 'read -r _ < "$2"'].join('\n'))
    const watchdog = startWatchdog({ quietLimitMs: 60_000, label: 'the reap with a killed scan made no progress' })
    const parent = spawn(sh, [file('parent.sh'), file('parentpid'), file('fifo')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    const reap = spawn(sh, ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, TG_REAP_TOKEN: token } })
    let reapErr = ''
    reap.stderr.on('data', (chunk: Buffer) => { reapErr += chunk.toString() })
    const reapExit = new Promise<number | null>((resolve, reject) => {
      reap.once('error', reject)
      reap.once('exit', (code) => { watchdog.progress('reap exited'); resolve(code) })
    })
    let watching = true
    const watchFiles = (async (): Promise<void> => {
      let seen = ''
      while (watching) {
        const now = `${read('parentpid')}/${read('calls')}`
        if (now !== seen) { seen = now; watchdog.progress(`state ${now}`) }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })()
    const got = { code: null as number | null, pid: '', calls: 0, seen: [] as string[], alive: true }
    try {
      got.code = await Promise.race([reapExit, watchdog.failed])
      got.pid = read('parentpid')
      got.calls = read('calls').split(/\s+/).filter((x) => x !== '').length
      got.seen = read('seen').split(/\s+/)
      if (/^[1-9]\d*$/.test(got.pid)) got.alive = spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${got.pid}`], { windowsHide: true, timeout: 30_000 }).status === 0
    } finally {
      watching = false
      await watchFiles
      watchdog.stop()
      if (reap.exitCode === null && reap.signalCode === null) reap.kill()
      if (parent.exitCode === null) parent.kill()
      reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.pid, 'the owned parent never started').toMatch(/^[1-9]\d*$/)
    expect(got.code, `the reap did not exit cleanly: ${reapErr}`).toBe(0)
    expect(got.calls, 'the scans that listed nothing were not repeated until one listed the parent').toBeGreaterThanOrEqual(3)
    expect(got.seen, 'the reap read its first scans as clean, so the parent was not in the set it killed first').toContain(got.pid)
    expect(got.alive, 'the owned parent is still running after a reap whose first scans listed nothing').toBe(false)
  }, 120_000)

  // Provenance: HAND-DERIVED from a macOS CI failure of the test above: macOS has no /proc, and its BSD `ps -e` lists the caller's own processes that have a terminal, with their environment, so a child started with no terminal was invisible to the kin scan, which also ran only where /proc exists. The branch is forced by making the /proc test fail, and `ps` is a function that answers as macOS does: `-wwAE` prints the owned parent with the token, `-e -o ...` prints nothing, and `-A -o ...` is the real listing.
  it('ends an owned child whose environment does not carry the token where there is no /proc and ps -e lists nothing', async () => {
    const noProc = REAP_SCRIPT.replace('[ -r /proc/self/environ ]', 'false')
    expect(noProc, 'the reap script no longer tests /proc with this text').not.toBe(REAP_SCRIPT)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shbsd-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const bsdPs = [
      'ps() {',
      '  case "$*" in',
      `    *-wwAE*) printf '%s\\n' "$(cat ${file('parentpid')}) x $tg_needle x" ;;`,
      "    '-e -o'*) ;;",
      '    *) command ps "$@" ;;',
      '  esac',
      '}',
    ].join('\n')
    const script = `${bsdPs}\n${noProc}`
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'tokenless child never started' })
    fs.writeFileSync(file('parent.sh'), [
      'mkfifo "$2"',
      'echo $$ > "$3"',
      `env -u ${OWNER_VAR} "$BASH" -c 'echo $$ > "$1"; read -r _ < "$2"' tg "$1" "$2" < /dev/null > /dev/null 2>&1`,
    ].join('\n'))
    const parent = spawn(sh, [file('parent.sh'), file('kid'), file('fifo'), file('parentpid')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    let kid = ''
    const got = { failure: null as string | null, alive: true }
    try {
      while (!/^[1-9]\d*$/.test(kid)) {
        if (fs.existsSync(file('kid'))) kid = fs.readFileSync(file('kid'), 'utf8').trim()
        if (!/^[1-9]\d*$/.test(kid)) await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), watchdog.failed])
      }
      watchdog.progress('tokenless child running')
      got.failure = reapOwned(sh, token, script)
      got.alive = spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${kid}`], { windowsHide: true, timeout: 30_000 }).status === 0
    } finally {
      watchdog.stop()
      if (parent.exitCode === null) parent.kill()
      if (/^[1-9]\d*$/.test(kid)) spawnSync(sh, ['-c', `kill -KILL ${kid}`], { windowsHide: true, timeout: 30_000 })
      reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the child that does not carry the token is still running after a reap with no /proc').toBe(false)
  }, 120_000)

  // Provenance: HAND-DERIVED. macOS has no /proc, so liveness there rests on `ps`; the branch is forced here by making the /proc test fail, and `ps` is a function that prints what the row names. A zombie state is gone though kill -0 answers yes for it; a live state, an empty listing and a ps that prints nothing for a running pid fall through to kill -0.
  it.each([['Z', false], ['Z+', false], ['S', true], ['', true]])('reads ps state %j as alive=%s where there is no /proc', (state, expected) => {
    const noProc = SH_LIVE.replace('[ -r /proc/self/stat ]', 'false')
    expect(noProc, 'the liveness helper no longer tests /proc with this text').not.toBe(SH_LIVE)
    const got = spawnSync(sh, ['-c', `${noProc}; ps() { printf '%s\\n' "$TG_FAKE_STATE"; }; tg_live $$`], { env: { ...process.env, TG_FAKE_STATE: state }, windowsHide: true, timeout: 30_000 })
    expect(got.status === 0).toBe(expected)
  })

  it('shares one subshell across a chunk of commands, so a run forks once per chunk', () => {
    const got = shRunAll(sh, ['tg_probe=set', 'token-goat "${tg_probe-unset}"'])
    expect(got.map((r) => r.calls)).toEqual([[], [['set']]])
  })

  it('still gives every command its run when one ends the shell partway through a chunk', () => {
    const commands = Array.from({ length: 40 }, (_, i) => `token-goat n${i}`)
    commands[3] = 'token-goat a; exit 3'
    commands[15] = 'token-goat b; exit'
    commands[16] = 'exit 1'
    commands[17] = 'token-goat "${tg_left-clean}"'
    const got = shRunAll(sh, commands)
    expect(got).toHaveLength(40)
    const want = commands.map((_, i) => [[`n${i}`]])
    want[3] = [['a']]
    want[15] = [['b']]
    want[16] = []
    want[17] = [['clean']]
    expect(got.map((r) => r.calls)).toEqual(want)
    expect(got.every((r) => r.stray.length === 0)).toBe(true)
  })
})
