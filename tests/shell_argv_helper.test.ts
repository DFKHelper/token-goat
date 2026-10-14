// The shell oracle behind the quoting tests: it must account for every command it was handed, say so when a shell was killed rather than report an empty stderr, and not fork a subshell per command, which under full-suite load took Git Bash past its 120 s cap at 158 of 184 commands. Provenance: HAND-DERIVED. Each expected argv is read off the command text by hand, independently of the helper's parser.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { OWNER_VAR, POSIX_SH, SH_LIVE, SH_SCRIPT, reapOwned, shRunAll } from './helpers/shell_argv.js'
import { startWatchdog } from './helpers/stall_proof_watchdog.js'

describe.skipIf(POSIX_SH === null)('shRunAll', () => {
  const sh = POSIX_SH!

  // A builtin loop rather than sleep: a child process would hold the output pipe open after the shell is killed. The budget is three times a measured warm run plus a second, so a loaded machine slow to start the shell still reaches the loop before the kill.
  it('names a timeout when the shell is killed before every command ran', () => {
    const started = Date.now()
    shRunAll(sh, ['token-goat w'])
    const warmMs = Date.now() - started
    const timeoutMs = Math.max(3000, warmMs * 5 + 2000)
    // Killing the outer shell must not orphan the chunk subshell or the process it is waiting on. Provenance: HAND-DERIVED. The child's loop is bounded by SECONDS so a helper regression leaks seconds of CPU instead of a core forever, and it marks its own expiry, so a loop that ran out before the check cannot pass for one the cleanup killed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shargv-'))
    try {
      const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
      const shq = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`
      const bound = Math.ceil(timeoutMs / 1000) + 20 + Math.ceil((warmMs * 5) / 1000)
      const child = `'echo $$ > "$1"; while [ "$SECONDS" -lt ${bound} ]; do :; done; : > "$2"'`
      const loop = `echo "\${BASHPID:-$(exec sh -c 'echo $PPID')}" > ${shq(file('pid'))}; "$BASH" -c ${child} tg ${shq(file('kid'))} ${shq(file('expired'))} < /dev/null > /dev/null 2>&1`
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
      // A builtin-only poll of up to two seconds in one spawn, since a fork per check cost Git Bash enough to outlast the bounded loop; it asks the cleanup's own liveness rule, since a stricter copy once read an exited MSYS pid as running and failed a cleanup that had succeeded.
      const poll = spawnSync(sh, ['-c', `${SH_LIVE}; while tg_live ${pids[0]} || tg_live ${pids[1]}; do [ "$SECONDS" -lt 2 ] || exit 1; done`], { windowsHide: true, timeout: 30_000 })
      expect(poll.status, 'the chunk subshell or its child is still running').toBe(0)
      expect(fs.existsSync(file('expired')), 'the child ran to its bound rather than being killed').toBe(false)
    } finally {
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

  it('exits immediately if TG_CHUNK is missing or non-positive rather than loop forever', () => {
    for (const chunk of ['', '0', '-1', 'notanumber']) {
      const res = spawnSync(sh, ['-c', SH_SCRIPT], { encoding: 'utf8', env: { ...process.env, TG_N: '5', TG_CHUNK: chunk }, windowsHide: true, timeout: 2000 })
      expect(res.status).toBe(1)
    }
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
