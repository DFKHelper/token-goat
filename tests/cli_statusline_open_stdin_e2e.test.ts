/** `token-goat statusline` on the built bundle with a stdin pipe the harness never writes to and never closes. The in-process test in cli_statusline.test.ts proves the read gives up after its idle window; only a spawned process shows whether the process then EXITS, which is what a status line that re-renders every few hundred ms needs. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-statusline-open-stdin-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('statusline with a stdin that never closes (built bundle)', () => {
  // HAND-DERIVED: the harness shape is "pipe attached, nothing written, never ended"; the 1500 ms idle window is STDIN_TIMEOUT_MS in src/cli_statusline.ts, so the process must print and exit well inside the 30 s allowance.
  it('prints a line and exits instead of staying alive on the open pipe', async () => {
    const child = spawn(process.execPath, [BUNDLE, 'statusline'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: path.join(home, 'tg') }),
      windowsHide: true,
    })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    const outcome = await new Promise<'exited' | 'hung'>((resolve) => {
      child.on('exit', () => resolve('exited'))
      setTimeout(() => resolve('hung'), 30_000)
    })
    if (outcome === 'hung') {
      const gone = new Promise<void>((resolve) => child.on('exit', () => resolve()))
      child.kill()
      await gone
    }
    expect(stdout.trim().length).toBeGreaterThan(0)
    expect(outcome).toBe('exited')
  }, 45_000)
})
