// A compress run whose shell is killed by a signal must exit with 128+signum and say so, never exit 0. Drives the REAL production path: bashRunner.run() -> wrapAndCompress -> spawn of the wrapped shell.
// CAPTURE: Node child 'exit' values from spawning `bash -c 'eval "$TG_CMD"'` on Git Bash (MSYS2) on Windows 11, 2026-10-26: `kill -TERM $$` -> code 3840 signal null; `kill -KILL $$` -> code 2304; `kill -INT $$` -> code 512; `kill -HUP $$` -> code 256; `exit 130` -> code 130; `exit 143` -> code 143; `exit 7` -> code 7.
import { describe, expect, it } from 'vitest'

import * as bashRunner from '../src/bash_runner.js'
import { normalizeChildEnd, signalExitCode } from '../src/util.js'
import { resolveWindowsBash } from '../src/shell.js'

const KILL_SELF_TERM = 'echo before; kill -TERM $$; echo after'
const KILL_SELF_KILL = 'echo before; kill -KILL $$; echo after'

describe('a signal death decodes to one (code, signal) shape on every platform', () => {
  it.each([
    ['TERM', 3840, 'SIGTERM', 143],
    ['KILL', 2304, 'SIGKILL', 137],
    ['INT', 512, 'SIGINT', 130],
    ['HUP', 256, 'SIGHUP', 129],
  ])('Git Bash wait status for %s (code %i) decodes to %s', (_name, code, signal, status) => {
    const end = normalizeChildEnd(code, null, 'win32')
    expect(end.signal).toBe(signal)
    expect(end.code).toBeNull()
    expect(signalExitCode(end.signal as NodeJS.Signals)).toBe(status)
  })

  it.each([0, 7, 130, 143])('a plain shell exit status %i is not read as a signal on win32', (code) => {
    expect(normalizeChildEnd(code, null, 'win32')).toEqual({ code, signal: null })
  })

  it('leaves a POSIX signal death as reported by Node', () => {
    expect(normalizeChildEnd(null, 'SIGTERM', 'linux')).toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('never reads a code as a signal off Windows', () => {
    expect(normalizeChildEnd(3840, null, 'linux')).toEqual({ code: 3840, signal: null })
  })
})

describe('compress reports a shell killed by a signal as that signal, end to end', () => {
  // Windows needs Git Bash for the wrapped shell; without it the wrapper falls back to cmd.exe and there is no signal to test.
  it.skipIf(process.platform === 'win32' && resolveWindowsBash() === null)('exits 143 with a stderr note when the shell kills itself with SIGTERM', async () => {
    let stdout = ''
    let stderr = ''
    const exit = await bashRunner.run(KILL_SELF_TERM, {
      timeout: 20,
      maxTokens: 100000,
      writeStdout: (s) => {
        stdout += s
      },
      writeStderr: (s) => {
        stderr += s
      },
    })

    expect(exit).toBe(143)
    expect(stdout).toContain('before')
    expect(stderr + stdout).toContain('command was killed by SIGTERM (exit 143)')
  }, 30000)

  it.skipIf(process.platform === 'win32' && resolveWindowsBash() === null)('exits 137 when the shell kills itself with SIGKILL', async () => {
    let stdout = ''
    const exit = await bashRunner.run(KILL_SELF_KILL, {
      timeout: 20,
      maxTokens: 100000,
      writeStdout: (s) => {
        stdout += s
      },
      writeStderr: () => {},
    })

    expect(exit).toBe(137)
    expect(stdout).toContain('killed by SIGKILL (exit 137)')
  }, 30000)
})
