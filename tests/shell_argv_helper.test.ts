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

  // A builtin wait rather than sleep: a child process would hold the output pipe open after the shell is killed. The timeout is five times a measured warm run plus two seconds, so a loaded machine slow to start the shell still reaches the wait before the kill.
  it('names a timeout when the shell is killed before every command ran', async () => {
    const started = Date.now()
    shRunAll(sh, ['token-goat w'])
    const warmMs = Date.now() - started
    const timeoutMs = Math.max(3000, warmMs * 5 + 2000)
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
        shRunAll(sh, ['token-goat a', loop, 'token-goat b'], { timeoutMs })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/ran 1 of 3 commands: .*(ETIMEDOUT|SIGTERM)/)
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
    // The run, plus a cleanup capped at 60 s whose environment scans took seven seconds each on a loaded Windows machine.
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

  // Provenance: HAND-DERIVED. The reap scans for owned processes, then kills what it found; a process forked after its last scan was never in that set and outlived the reap, which failed the timeout test above under full-suite load. The window is forced: the stop signal is made a no-op (it can land after a fork began) and the gap between the last scan and the kill lasts five seconds, in which the owned parent starts its child.
  it('ends an owned process that was started after the reap stopped scanning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shlate-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    // The kill waits for the late child to write its pid (up to 30 s), so the window is forced by an event and not by a clock a loaded host overruns.
    const slowed = REAP_SCRIPT.replace('kill -STOP $tg_new 2>/dev/null', ':').replace('[ -z "$tg_all" ] || { kill -KILL', `tg_i=0; while [ ! -s "${file('kid')}" ] && [ $tg_i -lt 300 ]; do sleep 0.1; tg_i=$((tg_i + 1)); done\n[ -z "$tg_all" ] || { kill -KILL`)
    expect(slowed.includes('tg_i=0;') && !slowed.includes('kill -STOP $tg_new'), 'the reap script no longer has the stop and kill lines this test slows').toBe(true)
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    // The parent waits three seconds on a FIFO nobody writes, then starts a child that blocks on a second FIFO, so only a kill ends it.
    fs.writeFileSync(file('parent.sh'), [
      'mkfifo "$2" "$3"',
      'exec 3<> "$3"',
      'read -t 3 -u 3 _',
      '"$BASH" -c \'echo $$ > "$1"; read -r _ < "$2"\' tg "$4" "$2" < /dev/null > /dev/null 2>&1',
    ].join('\n'))
    const parent = spawn(sh, [file('parent.sh'), 'x', file('fifo'), file('wait'), file('kid')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    const got = { failure: null as string | null, kid: '', alive: true }
    try {
      got.failure = reapOwned(sh, token, slowed)
      got.kid = fs.existsSync(file('kid')) ? fs.readFileSync(file('kid'), 'utf8').trim() : ''
      if (/^[1-9]\d*$/.test(got.kid)) got.alive = spawnSync(sh, ['-c', `${SH_LIVE}; tg_live ${got.kid}`], { windowsHide: true, timeout: 30_000 }).status === 0
    } finally {
      if (parent.exitCode === null) parent.kill()
      reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.kid, 'the late child never started, so the forced window did not happen').toMatch(/^[1-9]\d*$/)
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive,'the chunk subshell or its child is still running after the run returned').toBe(false)
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
