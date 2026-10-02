// Regression for a missing interpreter binary: spawn reports ENOENT as an error event / result.error rather than a close with a status, which the runner used to turn into exit 0 (passthrough) or an unhandled 'error' event that crashed the process (wrapAndCompress). Provenance: CAPTURE Node child_process behaviour on the authoring machine: spawnSync of a nonexistent file returns status null with error.code ENOENT; async spawn emits 'error' (ENOENT) and, on some platforms, no 'close'. 127 is the POSIX shell exit code for "command not found".
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as ShellNs from '../src/shell.js'

const MISSING = 'C:/definitely/not/here/token-goat-missing-interpreter.exe'

vi.mock('../src/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ShellNs>()
  return { ...actual, resolvePowerShell: () => MISSING }
})

import * as bashRunner from '../src/bash_runner.js'

describe('a spawn failure is reported as exit 127, not success or a crash', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passthrough returns 127 and names the error on stderr when the binary does not exist', () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => {
      writes.push(String(s))
      return true
    }) as typeof process.stderr.write)
    const exit = bashRunner.runRaw('Write-Output hi', 5, undefined, 'pwsh')
    expect(exit).toBe(127)
    expect(writes.join('')).toContain('ENOENT')
  })

  it('wrapAndCompress settles with 127 and carries the error text instead of crashing', async () => {
    let out = ''
    const exit = await bashRunner.run('Write-Output hi', {
      filterName: 'generic',
      shellType: 'pwsh',
      writeStdout: (s) => {
        out += s
      },
      writeStderr: () => {},
    })
    expect(exit).toBe(127)
    // The runner delivers captured stderr merged into the single stdout body.
    expect(out).toContain('ENOENT')
  })
})
