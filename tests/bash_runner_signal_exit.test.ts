// A compress run whose shell is killed by a signal must exit with 128+signum and say so, never exit 0. Drives the REAL production path: bashRunner.run() -> passthrough or wrapAndCompress -> spawn of the wrapped shell.
// CAPTURE: Node child 'exit' values from spawning `bash -c 'eval "$TG_CMD"'` on Git Bash (MSYS2) on Windows 11, 2026-10-26: `kill -TERM $$` -> code 3840 signal null; `kill -KILL $$` -> code 2304; `kill -INT $$` -> code 512; `kill -HUP $$` -> code 256; `exit 130` -> code 130; `exit 143` -> code 143; `exit 7` -> code 7. The same probe gave signum << 8 for ABRT (1536), TTIN (5376) and USR1 (7680), with no 0x80 core bit on ILL, TRAP, ABRT, FPE, BUS, SEGV, SYS, XCPU and XFSZ.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as bashRunner from '../src/bash_runner.js'
import { resolveWindowsBash } from '../src/shell.js'
import { normalizeChildEnd, signalExitCode } from '../src/bash_runner.js'
import { OWNER_VAR, reapOwned } from './helpers/shell_argv.js'

const KILL_SELF_TERM = 'echo before; kill -TERM $$; echo after'
const KILL_SELF_KILL = 'echo before; kill -KILL $$; echo after'
const KILL_SELF_TERM_QUIET = 'kill -TERM $$'

const hasBash = process.platform !== 'win32' || resolveWindowsBash() !== null

// Each run tags its child with a fresh owner token; afterEach reaps whatever a run left behind, on every path.
const owners: string[] = []

function reapShell(): string | null {
  return process.platform === 'win32' ? resolveWindowsBash() : '/bin/sh'
}

function runOwned(command: string, opts: bashRunner.RunOptions): Promise<number> {
  const token = randomUUID()
  owners.push(token)
  return bashRunner.run(command, { ...opts, env: { ...process.env, [OWNER_VAR]: token } })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const token of owners.splice(0)) {
    const sh = reapShell()
    if (sh !== null) expect(reapOwned(sh, token)).toBeNull()
  }
})

describe('a signal death decodes to one (code, signal) shape only for a Git Bash child on win32', () => {
  it.each([
    ['TERM', 3840, 'SIGTERM', 143],
    ['KILL', 2304, 'SIGKILL', 137],
    ['INT', 512, 'SIGINT', 130],
    ['HUP', 256, 'SIGHUP', 129],
    ['ABRT', 1536, 'SIGABRT', 134],
    ['TTIN', 5376, 'SIGTTIN', 149],
    ['USR1', 7680, 'SIGUSR1', 158],
  ])('Git Bash wait status for %s (code %i) decodes to %s', (_name, code, signal, status) => {
    const end = normalizeChildEnd(code, null, 'win32', 'msys-bash')
    expect(end.signal).toBe(signal)
    expect(end.code).toBeNull()
    expect(signalExitCode(signal as NodeJS.Signals, 'win32')).toBe(status)
  })

  it('a Cygwin signal the table has no name for keeps the shell status 128+signum', () => {
    expect(normalizeChildEnd(7 * 256, null, 'win32', 'msys-bash')).toEqual({ code: 135, signal: null })
  })

  it.each([0, 7, 130, 143])('a Git Bash plain exit status %i is not read as a signal on win32', (code) => {
    expect(normalizeChildEnd(code, null, 'win32', 'msys-bash')).toEqual({ code, signal: null })
  })

  it.each([256, 512, 3840, 7936])('a cmd, PowerShell or native exit status %i passes through unchanged on win32', (code) => {
    expect(normalizeChildEnd(code, null, 'win32', 'other')).toEqual({ code, signal: null })
  })

  it('leaves a POSIX signal death as reported by Node', () => {
    expect(normalizeChildEnd(null, 'SIGTERM', 'linux', 'other')).toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('never reads a code as a signal off Windows', () => {
    expect(normalizeChildEnd(3840, null, 'linux', 'msys-bash')).toEqual({ code: 3840, signal: null })
  })
})

describe('compress reports a shell killed by a signal as that signal, end to end', () => {
  // Windows needs Git Bash for the wrapped shell; without it the wrapper falls back to cmd.exe and there is no signal to test.
  it.skipIf(!hasBash)('passthrough exits 143 with one stderr note when the shell kills itself with SIGTERM', async () => {
    const stderrWrites: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(String(chunk))
      return true
    })

    const exit = await runOwned(KILL_SELF_TERM_QUIET, { timeout: 20 })

    expect(exit).toBe(143)
    expect(stderrWrites.filter((s) => s.includes('killed by'))).toEqual(['[token-goat: command was killed by SIGTERM]\n'])
  }, 30000)

  it.skipIf(process.platform !== 'win32')('passthrough returns a PowerShell exit 3840 as-is, with no signal note', async () => {
    const stderrWrites: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(String(chunk))
      return true
    })

    const exit = await runOwned('exit 3840', { timeout: 20, shellType: 'pwsh' })

    expect(exit).toBe(3840)
    expect(stderrWrites.filter((s) => s.includes('killed by'))).toEqual([])
  }, 30000)

  it.skipIf(!hasBash)('exits 143 with one stdout note when the shell kills itself with SIGTERM', async () => {
    let stdout = ''
    let stderr = ''
    const exit = await runOwned(KILL_SELF_TERM, {
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
    expect(stderr).toBe('')
    expect(stdout.split('command was killed by SIGTERM (exit 143)').length - 1).toBe(1)
  }, 30000)

  it.skipIf(!hasBash)('exits 137 with one stdout note when the shell kills itself with SIGKILL', async () => {
    let stdout = ''
    let stderr = ''
    const exit = await runOwned(KILL_SELF_KILL, {
      timeout: 20,
      maxTokens: 100000,
      writeStdout: (s) => {
        stdout += s
      },
      writeStderr: (s) => {
        stderr += s
      },
    })

    expect(exit).toBe(137)
    expect(stderr).toBe('')
    expect(stdout.split('command was killed by SIGKILL (exit 137)').length - 1).toBe(1)
  }, 30000)

  it.skipIf(process.platform !== 'win32').each([256, 3840])('capture returns a PowerShell exit %i as-is, with no signal note', async (code) => {
    let stdout = ''
    let stderr = ''
    const exit = await runOwned(`exit ${code}`, {
      timeout: 20,
      maxTokens: 100000,
      shellType: 'pwsh',
      writeStdout: (s) => {
        stdout += s
      },
      writeStderr: (s) => {
        stderr += s
      },
    })

    expect(exit).toBe(code)
    expect(stdout + stderr).not.toContain('killed by')
  }, 30000)
})
