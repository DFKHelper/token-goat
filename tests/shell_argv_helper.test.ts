// The shell oracle behind the quoting tests: it must account for every command it was handed, say so when a shell was killed rather than report an empty stderr, and not fork a subshell per command, which under full-suite load took Git Bash past its 120 s cap at 158 of 184 commands. Provenance: HAND-DERIVED. Each expected argv is read off the command text by hand, independently of the helper's parser.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { POSIX_SH, SH_LIVE, SH_SCRIPT, shRunAll } from './helpers/shell_argv.js'

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
