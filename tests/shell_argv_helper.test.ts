// The shell oracle behind the quoting tests: it must account for every command it was handed, say so when a shell was killed rather than report an empty stderr, and not fork a subshell per command, which under full-suite load took Git Bash past its 120 s cap at 158 of 184 commands. Provenance: HAND-DERIVED. Each expected argv is read off the command text by hand, independently of the helper's parser.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { OWNER_VAR, POSIX_SH, REAP_SCRIPT, SH_LIVE, SH_SCRIPT, TICK_FN, probeAlive, reapOwned, shRunAll } from './helpers/shell_argv.js'
import { startWatchdog } from './helpers/stall_proof_watchdog.js'

// A pass-through spy on spawnSync, so a row can read the timeout the helper handed to the spawn call.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

describe.skipIf(POSIX_SH === null)('shRunAll', () => {
  const sh = POSIX_SH!

  // Narrows the reap's token scan from every process in the table to the pids a row names, each read from a file when the scan starts: the rows that use it test the scan's repeat or its kin search, not how many processes the machine has, and the full-table grep took seconds per scan under load.
  const narrowScan = (script: string, pidFiles: string[]): string => {
    const head = 'tg_owned() {'
    const glob = '/proc/[0-9]*/environ'
    expect(script.includes(head) && script.includes(glob), 'the reap script no longer has the scan text this test narrows').toBe(true)
    const names = pidFiles.map((f) => `"${f}"`).join(' ')
    const own = `${head}\n  tg_scan=; for tg_nf in ${names}; do tg_nx=; read -r tg_nx 2>/dev/null < "$tg_nf"; [ -z "$tg_nx" ] || tg_scan="$tg_scan /proc/$tg_nx/environ"; done; [ -n "$tg_scan" ] || tg_scan=/dev/null`
    return script.replace(head, () => own).replace(glob, () => '$tg_scan')
  }

  // The same narrowing with the process listing fixed to nothing. The kin search reads `ps`, a whole-table pass that took 5-9 s under load, so a row that does not test the kin search fixes that listing too; the row that does keeps the real listing (see the row that names a tokenless child).
  // With `marker`, each listing that the fixture answers appends to that file, so a row can assert the fixture was the listing it read (a restored real listing leaves no marker).
  const fixScan = (script: string, pidFiles: string[], marker?: string): string => {
    const listing = /^case \$OSTYPE in msys\* \| cygwin\*\) tg_ps\(\) .*esac$/m
    const narrowed = narrowScan(script, pidFiles)
    expect(listing.test(narrowed), 'the reap script no longer defines its process listing on one line').toBe(true)
    const fixed = marker === undefined ? 'tg_ps() { :; }' : `tg_ps() { echo listed >> "${marker}"; :; }`
    // The fixed listing prints nothing, so the kin loop reads an empty table; it is called in place rather than through a command substitution, which would fork a subshell per scan to capture nothing (the table stays empty).
    const call = 'tg_tbl=$(tg_ps);'
    expect(narrowed.includes(call), 'the reap script no longer takes its kin listing with this text').toBe(true)
    return narrowed.replace(listing, () => fixed).replace(call, () => 'tg_tbl=; tg_ps;')
  }

  // fixScan with the narrowed token scan read by builtins as well. The grep stays in the production script, where one pass over the whole table is the fast way; for a scan narrowed to a few pids it was a command substitution, a fork each, and under load a fork took seconds. The rows that use this do not test the grep; the rows that force it to fail keep fixScan.
  const fixScanBuiltin = (script: string, pidFiles: string[], marker?: string): string => {
    const grepLoop = /^ *while \[ "\$tg_rc" -ge 128 \] && \[ "\$tg_try" -lt 10 \]; do tg_out=\$\(grep .*done$/m
    const fixed = fixScan(script, pidFiles, marker)
    expect(grepLoop.test(fixed), 'the reap script no longer scans with this grep loop').toBe(true)
    const own = 'tg_out=; tg_rc=0; for tg_ef in $tg_scan; do [ -r "$tg_ef" ] || continue; while IFS= read -r -d "" tg_el || [ -n "$tg_el" ]; do [ "$tg_el" = "$tg_needle" ] && { tg_out="$tg_out $tg_ef"; break; }; done < "$tg_ef" 2>/dev/null; done'
    return fixed.replace(grepLoop, () => own)
  }

  // True once /proc/PID/environ lists the owner token: the event the reap rows wait for before scanning, read with builtins so a poll forks nothing (a grep per tick cost one fork each).
  const ENVHAS = 'tg_envhas() { [ -r "/proc/$1/environ" ] || return 1; while IFS= read -r -d "" tg_el || [ -n "$tg_el" ]; do [ "$tg_el" = "$tg_needle" ] && return 0; done < "/proc/$1/environ"; return 1; }'

  // A builtin wait rather than sleep: a child process would hold the output pipe open after the shell is killed. The shell is ended by the event of the child having started, not by a clock, so a machine slow to start the shell still has the child at its wait when the kill lands.
  it('names the kill when the shell is ended before every command ran', async () => {
    // Killing the outer shell must not orphan the chunk subshell or the process it is waiting on. Provenance: HAND-DERIVED. The child blocks on an event that never comes and marks the moment its wait returns, so the pass condition is that marker staying absent, not a race against a clock.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shargv-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    // Set once every assertion below held, so the insurance scan in `finally` runs only for a row that did not prove the run gone.
    let verified = false
    try {
      const shq = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`
      // The child blocks on a FIFO nobody ever opens for writing, so only the kill can end it: no clock decides the outcome. `reached` is written only if the wait returned. The run's owner token is saved so the finally below can reap the child however the test ends.
      const child = `'echo $$ > "$1"; read -r _ < "$3"; : > "$2"'`
      const loop = `echo "\${BASHPID:-$(exec sh -c 'echo $PPID')}" > ${shq(file('pid'))}; echo "$${OWNER_VAR}" > ${shq(file('token'))}; mkfifo ${shq(file('fifo'))} && "$BASH" -c ${child} tg ${shq(file('kid'))} ${shq(file('reached'))} ${shq(file('fifo'))} < /dev/null > /dev/null 2>&1`
      let message = ''
      try {
        // The reap is the real one, narrowed to the two pids this row wrote, with its process listing fixed: the row tests that the killed shell's children are ended, which the narrowed scan still does, and not the whole-table search that cost tens of seconds under load.
        shRunAll(sh, ['token-goat a', loop, 'token-goat b'], { killWhen: () => fs.existsSync(file('kid')), reap: (s, token) => reapOwned(s, token, fixScanBuiltin(REAP_SCRIPT, [file('pid'), file('kid')], file('listed'))) })
      } catch (err) {
        message = (err as Error).message
      }
      // The reap keeps its kin listing in a variable, so it leaves no file at exit for a cleanup to remove; the `listed` check below proves the reap ran.
      expect(message).toMatch(/ran 1 of 3 commands: .*SIGTERM/)
      expect(message, message).not.toMatch(/cleanup/)
      const pids = ['pid', 'kid'].map((name) => fs.readFileSync(file(name), 'utf8').trim())
      for (const pid of pids) expect(pid).toMatch(/^[1-9]\d*$/)
      // shRunAll returned without a cleanup failure, so its reap has already waited, by the liveness rule asked here, for everything the run started to end: one check, no polling. The same rule is used because a stricter copy once read an exited MSYS pid as running and failed a cleanup that had succeeded.
      const alive = (): boolean => probeAlive(sh, `${SH_LIVE}; tg_live ${pids[0]} || tg_live ${pids[1]}`)
      expect(alive(), 'the chunk subshell or its child is still running after the run returned').toBe(false)
      expect(fs.existsSync(file('reached')), 'the child came back from its wait, so nothing killed it').toBe(false)
      expect(fs.existsSync(file('listed')), 'the reap read the whole process table instead of its fixture, so the row paid for a pass it does not test').toBe(true)
      verified = true
    } finally {
      // Insurance for a failed assertion: the owner token the run's processes carry, read from the file the loop wrote, ends anything still blocked.
      let token = ''
      try {
        token = fs.readFileSync(file('token'), 'utf8').trim()
      } catch {
        // The loop never ran, so no child exists to reap.
      }
      if (token !== '' && !verified) reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)

  // The blocked command reads a FIFO nobody writes, so the shell cannot finish and only the cap or the kill can end it: the outcome is decided by the cap, never by how fast the shell starts.
  it('names an ETIMEDOUT when the spawn timeout ends a shell that cannot finish', async () => {
    const real = await vi.importActual<typeof ChildProcessModule>('node:child_process')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shcap-'))
    const fifo = path.join(dir, 'fifo').replace(/\\/g, '/')
    try {
      let message = ''
      // The timeout the spawn call received is the evidence the cap was honoured, so no clock decides the row. The wrapper bounds a call that was handed a larger timeout, so an ignored cap fails the assertion below instead of blocking the suite for the 120 s default.
      const spawnCalls = vi.mocked(spawnSync)
      spawnCalls.mockClear()
      spawnCalls.mockImplementationOnce((...args: Parameters<typeof spawnSync>) => {
        const opts = (args[2] ?? {}) as { timeout?: number }
        return real.spawnSync(args[0], args[1] as string[], { ...opts, timeout: Math.min(opts.timeout ?? 5_000, 5_000) })
      })
      // The row tests the cap, not the cleanup scan, so it hands in a cleanup that only counts: the real scan took tens of seconds under load for a run that left nothing but a read that ends itself, since the FIFO is open for writing too and the read has its own limit.
      const reaps: string[] = []
      try {
        shRunAll(sh, [`mkfifo '${fifo}' && exec 3<>'${fifo}' && read -r -t 30 -u 3 _`], { timeoutMs: 1, reap: (_sh, token) => { reaps.push(token); return null } })
      } catch (err) {
        message = (err as Error).message
      }
      expect(reaps, 'the cap row did not clean up through the cleanup it was handed, so it paid for the real process-table scan').toHaveLength(1)
      const shellSpawn = spawnCalls.mock.calls.find((call) => (call[1] as string[] | undefined)?.[1] === SH_SCRIPT)
      expect((shellSpawn?.[2] as { timeout?: number } | undefined)?.timeout, 'the 1 ms cap was ignored: the shell spawn did not receive timeoutMs as its timeout').toBe(1)
      expect(message, 'the timeout did not name the cap that ended the shell').toMatch(/ran 0 of 1 commands: .*ETIMEDOUT/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Same blocked command, but the kill is asked for by killWhen, which never comes true: only the deadline that the timeout sets can end the shell, so the run must still name its ETIMEDOUT.
  it('ends a shell that never reaches its killWhen event at the timeout deadline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shdl-'))
    const fifo = path.join(dir, 'fifo').replace(/\\/g, '/')
    const pidFile = path.join(dir, 'pid').replace(/\\/g, '/')
    const marker = path.join(dir, 'listed').replace(/\\/g, '/')
    try {
      let message = ''
      // The blocked read ends itself after its own limit, so it leaves nothing behind even if the reap found nothing. The reap is the real one, narrowed to the pid the command wrote, so the row pays for one cheap reap rather than a whole-table pass.
      const loop = `echo "\${BASHPID:-$(exec sh -c 'echo $PPID')}" > '${pidFile}'; mkfifo '${fifo}' && exec 3<>'${fifo}' && read -r -t 30 -u 3 _`
      try {
        shRunAll(sh, [loop], { killWhen: () => false, timeoutMs: 2000, reap: (s, token) => reapOwned(s, token, fixScanBuiltin(REAP_SCRIPT, [pidFile], marker)) })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message, 'the killWhen run did not end at its deadline').toMatch(/ran 0 of 1 commands: .*ETIMEDOUT/)
      expect(message, message).not.toMatch(/cleanup/)
      expect(fs.existsSync(marker), 'the reap read the whole process table instead of its fixture, so the row paid for a pass it does not test').toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Provenance: HAND-DERIVED, from a hand-observed leak of two looping shells whose parent was gone for three days. Under Git Bash a native parent reads as `$PPID` 1, so the shell cannot ask whether its parent lives; its own `TG_BUDGET_S` deadline is what ends it. The launcher is a short-lived node process that starts the real SH_SCRIPT, waits until the shell is looping, and exits without stopping it; the wait is a stall-proof watchdog and the shell is reaped by its owner token in `finally` however the test ends.
  it('exits on its own when the process that launched it is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shorphan-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'orphaned shell did not exit' })
    let launcher: ChildProcess | undefined
    let leftover: string | null
    // True once the shell was seen gone by itself; a shell that ended on its own left nothing for a cleanup scan, which cost tens of seconds under load.
    let endedByItself = false
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
      const alive = (): boolean => probeAlive(sh, `${SH_LIVE}; tg_live ${pid}`)
      const gone = (async (): Promise<void> => {
        while (alive()) await new Promise((resolve) => setTimeout(resolve, 200))
        watchdog.progress('shell gone')
      })()
      await Promise.race([gone, watchdog.failed])
      endedByItself = true
    } finally {
      watchdog.stop()
      if (launcher !== undefined && launcher.exitCode === null) launcher.kill()
      leftover = endedByItself ? null : reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(leftover, 'the cleanup of the test shell failed').toBeNull()
  })

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
      ENVHAS,
      'tg_pp=',
      'until [ -n "$tg_pp" ] && { if [ -r /proc/self/environ ]; then tg_envhas "$tg_pp"; else tg_light=; tg_owned; case " $tg_found " in *" $tg_pp "*) true ;; *) false ;; esac; fi; }; do',
      `  read -r tg_pp 2>/dev/null < "${file('parentpid')}"`,
      '  echo wait',
      '  tg_tick',
      'done',
      'for tg_round in 1 2 3 4 5; do',
      '  echo round',
    ].join('\n')
    // After its last scan the reap releases the parent and holds the kill until the late child wrote its pid or the parent is gone.
    const holdKill = [
      SH_LIVE,
      `echo "$tg_all" > "${file('seen')}"`,
      `: > "${file('release')}"`,
      `until [ -s "${file('kid')}" ] || ! tg_live "$tg_pp"; do echo hold; tg_tick; done`,
      '[ -z "$tg_all" ] || { kill -KILL',
    ].join('\n')
    // The token scan reads only the owned parent and the late child's pid file, and the process listing is fixed empty: this row tests the window the scan stopped in, not the kin search, which the tokenless-child row runs on the real listing.
    const slowed = patch(patch(patch(patch(fixScanBuiltin(REAP_SCRIPT, [file('parentpid'), file('kid')], file('listed')), 'kill -STOP $tg_new 2>/dev/null', ':'), 'for tg_round in 1 2 3 4 5; do', waitForParent), '[ -z "$tg_all" ] || { kill -KILL', holdKill), '  tg_left=\n', '  echo drain\n  tg_left=\n')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    // The parent waits for the release file, then starts a child that blocks on a FIFO nobody writes, so only a kill ends it; its own errors land in a file.
    fs.writeFileSync(file('parent.sh'), [
      TICK_FN,
      'exec 2> "$5"',
      'mkfifo "$2"',
      'echo $$ > "$1"',
      'until [ -e "$3" ]; do [ "$SECONDS" -lt 600 ] || exit 1; tg_tick; done',
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
    const got = { failure: null as string | null, kid: '', parentPid: '', seen: [] as string[], err: '', alive: true, listed: false }
    try {
      const code = await Promise.race([reapExit, watchdog.failed])
      got.failure = code === 0 ? null : `exit status ${String(code)}; ${reapErr.trim()}`
      got.kid = read('kid')
      got.parentPid = read('parentpid')
      got.listed = fs.existsSync(file('listed'))
      got.seen = read('seen').split(/\s+/)
      got.err = read('err')
      if (/^[1-9]\d*$/.test(got.kid)) got.alive = probeAlive(sh, `${SH_LIVE}; tg_live ${got.kid}`)
    } finally {
      watching = false
      await watchFiles
      watchdog.stop()
      if (reap.exitCode === null && reap.signalCode === null) reap.kill()
      if (parent.exitCode === null) parent.kill()
      // The row's own reap exiting 0 means two scans in a row found nothing alive, and the probe saw the child gone, so a second scan has nothing to find; it runs only for a row that did not show that.
      if (got.failure !== null || got.alive) reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.kid, `the late child never started, so the forced window did not happen; the parent said: ${got.err}; the reap said: ${got.failure}`).toMatch(/^[1-9]\d*$/)
    expect(got.seen, 'the reap did not hold the parent when it released it').toContain(got.parentPid)
    expect(got.seen, 'the late child was already in the reap set, so the forced window did not happen').not.toContain(got.kid)
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the chunk subshell or its child is still running after the run returned').toBe(false)
    expect(got.listed, 'the reap read the whole process table instead of its fixture, so the row paid for a pass it does not test').toBe(true)
  })

  // Provenance: HAND-DERIVED, from a captured failure under a fork storm: under MSYS a child shows in /proc stat, with its parent and group, one to several seconds before its environment can be read, so a child its parent started just before being killed was invisible to a reap that looks only for the token and outlived it. The window is forced by starting the child with the token removed from its environment, which is what the token scan sees of an uninitialised MSYS child; the owned parent stays alive and blocked, so the reap can end the child only by finding it through its parent.
  it('ends an owned child whose environment does not carry the token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shkin-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'tokenless child never started' })
    fs.writeFileSync(file('parent.sh'), [
      'mkfifo "$2"',
      'echo $$ > "$3"',
      `env -u ${OWNER_VAR} "$BASH" -c 'echo $$ > "$1"; read -r _ < "$2"' tg "$1" "$2" < /dev/null > /dev/null 2>&1`,
    ].join('\n'))
    // The token scan lists only the owned parent: the child carries no token, so it is found through the kin search of the real process listing, which this row tests.
    const script = narrowScan(REAP_SCRIPT, [file('parentpid')])
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
      got.alive = probeAlive(sh, `${SH_LIVE}; tg_live ${kid}`)
    } finally {
      watchdog.stop()
      if (parent.exitCode === null) parent.kill()
      // A shell to kill a child already shown gone is a fork the row does not need, so it runs only for a row that did not show that.
      if (/^[1-9]\d*$/.test(kid) && (got.failure !== null || got.alive)) spawnSync(sh, ['-c', `kill -KILL ${kid}`], { windowsHide: true, timeout: 30_000 })
      // A reap that returned null found nothing alive twice in a row and the probe saw the child gone, so the insurance scan runs only for a row that did not show that.
      if (got.failure !== null || got.alive) reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the child that does not carry the token is still running after the reap returned').toBe(false)
  })

  // Provenance: HAND-DERIVED from the review of the commit that took the kin listing once per reap: the light scans (no token grep) had no other detector, so a tokenless child its owned parent forked after the first listing was in no listing and outlived the reap. The fork is ordered by events: the owned parent blocks on a FIFO the reap writes right after its first kin listing, and the reap then waits for the child's pid file before it goes on to stop the parent, so the child exists strictly after the first listing and before the reap's next scan.
  it('ends a tokenless child its owned parent forked after the first kin listing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shlate-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const childToken = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'owned parent never started' })
    fs.writeFileSync(file('parent.sh'), [
      'mkfifo "$2" "$4"',
      'echo $$ > "$3"',
      'read -r _ < "$2"',
      `env ${OWNER_VAR}=${childToken} "$BASH" -c 'echo $$ > "$1"; read -r _ < "$2"' tg "$1" "$4" < /dev/null > /dev/null 2>&1`,
    ].join('\n'))
    const hook = '[ -z "$tg_found$tg_all" ] || tg_listed=1;'
    const signal = `${hook} [ -n "$tg_listed" ] && [ -z "$tg_hs" ] && { tg_hs=1; echo go > "${file('go')}"; while [ ! -e "${file('kid')}" ]; do tg_tick; done; };`
    const narrowed = narrowScan(REAP_SCRIPT, [file('parentpid')])
    expect(narrowed.includes(hook), 'the reap script no longer marks its first kin listing where this row signals').toBe(true)
    const script = narrowed.replace(hook, () => signal)
    const parent = spawn(sh, [file('parent.sh'), file('kid'), file('go'), file('parentpid'), file('hold')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    let kid = ''
    const got = { failure: null as string | null, alive: true }
    try {
      while (!fs.existsSync(file('parentpid')) || fs.readFileSync(file('parentpid'), 'utf8').trim() === '') await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), watchdog.failed])
      watchdog.progress('owned parent running')
      got.failure = reapOwned(sh, token, script)
      kid = fs.existsSync(file('kid')) ? fs.readFileSync(file('kid'), 'utf8').trim() : ''
      if (/^[1-9]\d*$/.test(kid)) got.alive = probeAlive(sh, `${SH_LIVE}; tg_live ${kid}`)
    } finally {
      watchdog.stop()
      if (parent.exitCode === null) parent.kill()
      // Read again here: a reap that threw left the pid unread, and the token reap cannot see a tokenless child whose parent is gone.
      kid = fs.existsSync(file('kid')) ? fs.readFileSync(file('kid'), 'utf8').trim() : kid
      // A shell to kill a child already shown gone is a fork the row does not need, so it runs only for a row that did not show that.
      if (/^[1-9]\d*$/.test(kid) && (got.failure !== null || got.alive)) spawnSync(sh, ['-c', `kill -KILL ${kid}`], { windowsHide: true, timeout: 30_000 })
      if (got.failure !== null || got.alive) reapOwned(sh, token)
      // The child carries its own token, so this reap finds it even when the parent is gone and the kin listing cannot.
      if (got.failure !== null || got.alive) reapOwned(sh, childToken)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(kid, 'the owned parent never forked its child after the first kin listing').toMatch(/^[1-9]\d*$/)
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the tokenless child forked after the first kin listing is still running after the reap returned').toBe(false)
  })

  // Provenance: HAND-DERIVED from a review of the reap: the final listing of the break round is taken while a seed is signalled but not yet stopped, the seed then forks a tokenless child, and the KILL takes the seed, which stays a zombie while its parent waits in spawnSync. Every seed is then dead and the seed set is unchanged since that listing, so only the forced post-kill listing can name the child. The window is forced without a clock: the STOP is made a no-op and the reap, holding its kill after the last listing, releases the parent and waits for the child's pid file.
  it('ends a tokenless child its owned parent forked after the last listing and before the kill', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shlate-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const childToken = `${process.pid}-${randomBytes(8).toString('hex')}`
    const watchdog = startWatchdog({ quietLimitMs: 30_000, label: 'owned parent never started' })
    fs.writeFileSync(file('parent.sh'), [
      'mkfifo "$2" "$4"',
      'echo $$ > "$3"',
      'read -r _ < "$2"',
      `env ${OWNER_VAR}=${childToken} "$BASH" -c 'echo $$ > "$1"; read -r _ < "$2"' tg "$1" "$4" < /dev/null > /dev/null 2>&1`,
    ].join('\n'))
    const stop = 'kill -STOP $tg_new 2>/dev/null'
    const hold = '[ -z "$tg_all" ] || { kill -KILL'
    const narrowed = narrowScan(REAP_SCRIPT, [file('parentpid')])
    expect(narrowed.includes(stop) && narrowed.includes(hold), 'the reap script no longer has the stop and kill text this row patches').toBe(true)
    const release = `echo go > "${file('go')}"; while [ ! -e "${file('kid')}" ]; do tg_tick; done`
    const script = narrowed.replace(stop, () => ':').replace(hold, () => `${release}\n${hold}`)
    const parent = spawn(sh, [file('parent.sh'), file('kid'), file('go'), file('parentpid'), file('hold')], { stdio: 'ignore', windowsHide: true, env: { ...process.env, [OWNER_VAR]: token } })
    let kid = ''
    const got = { failure: null as string | null, alive: true }
    try {
      while (!fs.existsSync(file('parentpid')) || fs.readFileSync(file('parentpid'), 'utf8').trim() === '') await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), watchdog.failed])
      watchdog.progress('owned parent running')
      got.failure = reapOwned(sh, token, script)
      kid = fs.existsSync(file('kid')) ? fs.readFileSync(file('kid'), 'utf8').trim() : ''
      if (/^[1-9]\d*$/.test(kid)) got.alive = probeAlive(sh, `${SH_LIVE}; tg_live ${kid}`)
    } finally {
      watchdog.stop()
      if (parent.exitCode === null) parent.kill()
      // Read again here: a reap that threw left the pid unread, and the token reap cannot see a tokenless child whose parent is gone.
      kid = fs.existsSync(file('kid')) ? fs.readFileSync(file('kid'), 'utf8').trim() : kid
      // A shell to kill a child already shown gone is a fork the row does not need, so it runs only for a row that did not show that.
      if (/^[1-9]\d*$/.test(kid) && (got.failure !== null || got.alive)) spawnSync(sh, ['-c', `kill -KILL ${kid}`], { windowsHide: true, timeout: 30_000 })
      if (got.failure !== null || got.alive) reapOwned(sh, token)
      // The child carries its own token, so this reap finds it even when the parent is gone and the kin listing cannot.
      if (got.failure !== null || got.alive) reapOwned(sh, childToken)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(kid, 'the owned parent never forked its child after the last listing').toMatch(/^[1-9]\d*$/)
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the tokenless child forked after the last listing and before the kill is still running after the reap returned').toBe(false)
  })

  // Provenance: HAND-DERIVED from a captured scan: the grep the reap runs to list every process carrying the token was killed by SIGHUP after four seconds and printed nothing, and the reap read that as no owned process, so it ended with the run's processes still alive. The failure is forced by a `grep` function that dies (status 129, no output) on its first two calls, which are the two scans the old reap counted as clean; the owned parent stays blocked, so only a scan that is repeated finds it. The reap runs asynchronously under the stall-proof watchdog, fed by the scan calls and the files the test waits on.
  // Provenance: HAND-DERIVED from a second capture: a scan that finished with status 2 and no error naming the owned process, which was alive and forking, listed everything but it (1 of 32 scans under load). The case is forced by a `grep` that prints nothing and exits 1 on its first two calls.
  // macOS has no /proc, so its reap scans with ps and never calls the grep these rows force to fail.
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
      `  echo "$#" >> "${file('grepargs')}"`,
      `  if [ "$tg_n" -lt 2 ]; then ${dies}; fi`,
      '  command grep "$@"',
      '}',
    ].join('\n')
    // The reap starts scanning only once the parent's environment is readable, so a young MSYS process cannot make the scan miss for a reason this test does not force.
    const waitForParent = [
      ENVHAS,
      'tg_pp=',
      // The wait ends on the event, not on a count of polls: a parent that never shows its token is a stall the watchdog names, since the reap then makes no progress.
      'until [ -n "$tg_pp" ] && tg_envhas "$tg_pp"; do',
      `  read -r tg_pp 2>/dev/null < "${file('parentpid')}"`,
      '  tg_tick',
      'done',
      'tg_all=',
      'for tg_round in 1 2 3 4 5; do',
    ].join('\n')
    const base = REAP_SCRIPT
    expect(base.includes('tg_all=\nfor tg_round in 1 2 3 4 5; do'), 'the reap script no longer starts its rounds with this text').toBe(true)
    const hold = '[ -z "$tg_all" ] || { kill -KILL'
    expect(base.includes(hold), 'the reap script no longer kills with this text').toBe(true)
    const recorded = base.replace(hold, () => `echo "$tg_all" > "${file('seen')}"\n${hold}`)
    const script = `${fakeGrep}\n${fixScan(recorded, [file('parentpid')], file('listed')).replace('tg_all=\nfor tg_round in 1 2 3 4 5; do', () => waitForParent)}`
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
    const got = { code: null as number | null, pid: '', calls: 0, args: [] as string[], seen: [] as string[], alive: true, listed: false }
    try {
      got.code = await Promise.race([reapExit, watchdog.failed])
      got.pid = read('parentpid')
      got.calls = read('calls').split(/\s+/).filter((x) => x !== '').length
      got.listed = fs.existsSync(file('listed'))
      got.args = read('grepargs').split(/\s+/).filter((x) => x !== '')
      got.seen = read('seen').split(/\s+/)
      if (/^[1-9]\d*$/.test(got.pid)) got.alive = probeAlive(sh, `${SH_LIVE}; tg_live ${got.pid}`)
    } finally {
      watching = false
      await watchFiles
      watchdog.stop()
      if (reap.exitCode === null && reap.signalCode === null) reap.kill()
      if (parent.exitCode === null) parent.kill()
      // The row's own reap exiting 0 means two scans in a row found nothing alive, and the probe saw the owned parent gone, so the insurance scan runs only for a row that did not show that.
      if (got.code !== 0 || got.alive) reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.pid, 'the owned parent never started').toMatch(/^[1-9]\d*$/)
    expect(got.code, `the reap did not exit cleanly: ${reapErr}`).toBe(0)
    expect(got.calls, 'the scans that listed nothing were not repeated until one listed the parent').toBeGreaterThanOrEqual(3)
    // The scan's arguments are the option, the pattern flag and pattern, and the one owned parent: a count above four means the scan walked the whole process table, the cost this row does not test.
    expect(got.args, 'the scan was not narrowed to the owned parent').toEqual(new Array<string>(got.calls).fill('4'))
    expect(got.seen, 'the reap read its first scans as clean, so the parent was not in the set it killed first').toContain(got.pid)
    expect(got.alive, 'the owned parent is still running after a reap whose first scans listed nothing').toBe(false)
    expect(got.listed, 'the reap read the whole process table instead of its fixture, so the row paid for a pass it does not test').toBe(true)
  })

  // Provenance: HAND-DERIVED from a macOS CI failure of the test above: macOS has no /proc, and its BSD `ps -e` lists the caller's own processes that have a terminal, with their environment, so a child started with no terminal was invisible to the kin scan, which also ran only where /proc exists. The branch is forced by making the /proc test fail, and `ps` is a function that answers as macOS does: `-wwAE` prints the owned parent with the token, `-e -o ...` prints nothing, and `-A -o ...` is the real listing.
  it('ends an owned child whose environment does not carry the token where there is no /proc and ps lists only the owned parent and the late child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shbsd-'))
    const file = (name: string): string => path.join(dir, name).replace(/\\/g, '/')
    // The /proc test is forced false, and the environ scan is narrowed to the two pid files, so the row does not pay the whole-table /proc grep under load; the kin listing the row tests is still the real fixture above.
    const noProc = narrowScan(REAP_SCRIPT.replace('[ -r /proc/self/environ ]', 'false'), [file('parentpid'), file('kid')])
    expect(noProc, 'the reap script no longer tests /proc with this text').not.toBe(REAP_SCRIPT)
    const bsdPs = [
      'ps() {',
      `  tg_pa=; tg_ka=; read -r tg_pa < "${file('parentpid')}"; read -r tg_ka < "${file('kid')}"`,
      '  case "$*" in',
      `    *-wwAE*) printf '%s\\n' "$tg_pa x $tg_needle x" ;;`,
      // The listing the kin search reads, fixed to the owned parent and its late child, so the row does not pay for a whole-table `ps` under load; the child has no token, so only this listing can name it.
      `    '-e'|'-A -o'*) echo listed >> '${file('listed')}'; printf '%s 1 %s S\\n%s %s %s S\\n' "$tg_pa" "$tg_pa" "$tg_ka" "$tg_pa" "$tg_ka" ;;`,
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
    const got = { failure: null as string | null, alive: true, listed: false }
    try {
      while (!/^[1-9]\d*$/.test(kid)) {
        if (fs.existsSync(file('kid'))) kid = fs.readFileSync(file('kid'), 'utf8').trim()
        if (!/^[1-9]\d*$/.test(kid)) await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), watchdog.failed])
      }
      watchdog.progress('tokenless child running')
      got.failure = reapOwned(sh, token, script)
      got.alive = probeAlive(sh, `${SH_LIVE}; tg_live ${kid}`)
      got.listed = fs.existsSync(file('listed'))
    } finally {
      watchdog.stop()
      if (parent.exitCode === null) parent.kill()
      // A shell to kill a child already shown gone is a fork the row does not need, so it runs only for a row that did not show that.
      if (/^[1-9]\d*$/.test(kid) && (got.failure !== null || got.alive)) spawnSync(sh, ['-c', `kill -KILL ${kid}`], { windowsHide: true, timeout: 30_000 })
      // A reap that returned null found nothing alive twice in a row and the probe saw the child gone, so the insurance scan runs only for a row that did not show that.
      if (got.failure !== null || got.alive) reapOwned(sh, token)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(got.failure, 'the reap reported it could not end the run').toBeNull()
    expect(got.alive, 'the child that does not carry the token is still running after a reap with no /proc').toBe(false)
    expect(got.listed, 'the reap listed the process table instead of its fixture, so the row paid for a pass it does not test').toBe(true)
  })

  // Provenance: HAND-DERIVED. macOS has no /proc, so liveness there rests on `ps`; the branch is forced here by making the /proc test fail, and `ps` is a function that prints what the row names. A zombie state is gone though kill -0 answers yes for it; a live state, an empty listing and a ps that prints nothing for a running pid fall through to kill -0.
  it.each([['Z', false], ['Z+', false], ['S', true], ['', true]])('reads ps state %j as alive=%s where there is no /proc', (state, expected) => {
    const noProc = SH_LIVE.replace('[ -r /proc/self/stat ]', 'false')
    expect(noProc, 'the liveness helper no longer tests /proc with this text').not.toBe(SH_LIVE)
    const got = spawnSync(sh, ['-c', `${noProc}; ps() { printf '%s\\n' "$TG_FAKE_STATE"; }; tg_live $$`], { env: { ...process.env, TG_FAKE_STATE: state }, windowsHide: true, timeout: 30_000 })
    expect([0, 1], `the liveness probe gave no answer: status ${String(got.status)}`).toContain(got.status)
    expect(got.status === 0).toBe(expected)
  })

  // Provenance: HAND-DERIVED, from a captured failure: under full-suite load the orphan row's shell took longer than its 2 s budget to reach its first command, exited 1 before writing its pid file, and the row stalled until its watchdog gave up. The slow start is forced without a clock: bash takes its initial `$SECONDS` from the environment, so a shell started with 100 has already used far more than the 2 s budget before its script begins. The budget counts from the script, so the command still runs.
  it('counts its run budget from the start of the script, not from the start of the shell process', () => {
    const res = spawnSync(sh, ['-c', SH_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, SECONDS: '100', TG_N: '1', TG_CHUNK: '16', TG_BUDGET_S: '2', TG_CMD_0: 'token-goat ran' } })
    expect(res.stdout, `status ${String(res.status)}: the shell ended on its budget before its first command`).toBe('\0C1\0ran\0\0E0\0\0X\0')
    expect(res.status).toBe(0)
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
    // Nothing in these commands blocks, so the reap the early exit triggers has nothing to end; it runs over an empty fixture instead of a whole-table pass.
    const got = shRunAll(sh, commands, { reap: (s, token) => reapOwned(s, token, fixScanBuiltin(REAP_SCRIPT, [])) })
    expect(got).toHaveLength(40)
    const want = commands.map((_, i) => [[`n${i}`]])
    want[3] = [['a']]
    want[15] = [['b']]
    want[16] = []
    want[17] = [['clean']]
    expect(got.map((r) => r.calls)).toEqual(want)
    expect(got.every((r) => r.stray.length === 0)).toBe(true)
  })

  // A present /proc entry with an empty stat is unknown, so the probe answers alive; only a missing entry or a zombie is gone. Provenance: HAND-DERIVED from the SH_LIVE rule, on a fake /proc root through TG_PROC_ROOT.
  it.skipIf(process.platform === 'darwin')('reads a /proc entry with an empty stat as alive, not as gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shlive-'))
    try {
      fs.mkdirSync(path.join(dir, '4242'))
      fs.writeFileSync(path.join(dir, '4242', 'stat'), '')
      fs.mkdirSync(path.join(dir, '4244'))
      fs.writeFileSync(path.join(dir, '4244', 'stat'), '4244 (x) Z 1 4244 4244 0 -1 0\n')
      const root = dir.replace(/\\/g, '/')
      const live = (pid: number): boolean => probeAlive(sh, `${SH_LIVE}; TG_PROC_ROOT='${root}'; export TG_PROC_ROOT; tg_live ${pid}`)
      expect(live(4242), 'an empty stat under a present entry was read as gone').toBe(true)
      expect(live(4243), 'a pid with no /proc entry was read as alive').toBe(false)
      expect(live(4244), 'a zombie was read as alive').toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
