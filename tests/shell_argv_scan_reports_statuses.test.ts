// The reap's owned-process scan repeats a killed grep ten times; its failure must name each attempt's status.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { POSIX_SH, REAP_SCRIPT, reapOwned } from './helpers/shell_argv.js'
import { startWatchdog } from './helpers/stall_proof_watchdog.js'

// macOS has no /proc, so its reap scans with ps and never calls the grep this row forces to die.
describe.skipIf(POSIX_SH === null || process.platform === 'darwin')('the owned-process scan failure', () => {
  const sh = POSIX_SH!

  // Provenance: HAND-DERIVED: a `grep` function returning 137 on every call stands in for a grep ended by SIGKILL.
  it('lists the exit status of each of the ten attempts', async () => {
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const script = `grep() { return 137; }\n${REAP_SCRIPT}`
    const label = 'the reap with a killed scan made no progress'
    const watchdog = startWatchdog({ quietLimitMs: 60_000, label })
    const env = { ...process.env, TG_REAP_TOKEN: token }
    const child = spawn(sh, ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      watchdog.progress('reap stderr')
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (status) => {
        watchdog.progress('reap exited')
        resolve(status)
      })
    })
    try {
      const code = await Promise.race([exited, watchdog.failed])
      expect(code, 'the reap must fail when every scan attempt is killed').toBe(1)
    } finally {
      watchdog.stop()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      reapOwned(sh, token)
    }
    expect(stderr, 'the message names the failure').toContain('the owned-process scan was killed ten times')
    const listed = /exit statuses: (137 ){9}137\)/
    expect(stderr, 'the message lists the exit status of each of the ten attempts').toMatch(listed)
  })
})
