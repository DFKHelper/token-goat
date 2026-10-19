// Provenance: FORMAT-DERIVED. The macOS `ps` outputs are read off Apple's open-source adv_cmds-237 ps.c (https://github.com/apple-oss-distributions/adv_cmds/blob/adv_cmds-237/ps/ps.c) and print.c: addelem_pid rejects a pid above BSD_PID_MAX (99999) with warnx("%s too large: %s", "process id", elem), which prints "ps: process id too large: N" on stderr, and optfatal then exits 1 before any process is listed; a pid of 99999 or less that no process holds reaches nkept == 0 and exit(1), after printheader, which prints nothing when every column header is empty (`-o args=`). The kernel answers are Node's documented process.kill(pid, 0) existence test (https://nodejs.org/api/process.html#processkillpid-signal) with kill(2)'s ESRCH (no such process) and EPERM (exists, not ours). Not CAPTURE: no macOS machine was run; the macOS CI row in tests/resident_process.test.ts is the live check. The ps run and the platform are stood in, so every row drives the darwin branch of the real queryProcessCommandLine on any OS.
import type * as ChildProcessModule from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof ChildProcessModule>()), spawnSync: spawn.run }))

import { classifyPosixPsRun, queryProcessCommandLine } from '../src/resident_process.js'

const TOO_LARGE = 'ps: process id too large: 2147483646\n'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor

function kernelError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code })
}

describe('queryProcessCommandLine on darwin', () => {
  let kill: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    kill = vi.spyOn(process, 'kill')
  })

  afterEach(() => {
    kill.mockRestore()
    Object.defineProperty(process, 'platform', realPlatform)
    spawn.run.mockReset()
  })

  function psRan(status: number | null, stdout: string, stderr: string): void {
    spawn.run.mockReturnValue({ status, stdout, stderr, error: undefined })
  }

  it('reads a pid above the macOS ceiling as gone when the kernel reports no such process', () => {
    psRan(1, '', TOO_LARGE)
    kill.mockImplementation(() => {
      throw kernelError('ESRCH')
    })
    expect(queryProcessCommandLine(2147483646)).toEqual({ status: 'gone' })
    expect(kill).toHaveBeenCalledWith(2147483646, 0)
  })

  it('reads the silent exit 1 of a missing pid as gone without asking the kernel', () => {
    psRan(1, '', '')
    expect(queryProcessCommandLine(4242)).toEqual({ status: 'gone' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('keeps a stderr-bearing exit 1 failed when the kernel says the process exists but is not ours', () => {
    psRan(1, '', TOO_LARGE)
    kill.mockImplementation(() => {
      throw kernelError('EPERM')
    })
    expect(queryProcessCommandLine(4242)).toEqual({ status: 'failed' })
  })

  it('keeps a stderr-bearing exit 1 failed when the kernel finds the process', () => {
    psRan(1, '', 'ps: something else went wrong\n')
    kill.mockReturnValue(true)
    expect(queryProcessCommandLine(4242)).toEqual({ status: 'failed' })
  })

  it('keeps an exit status other than 1 failed even when the kernel reports no such process', () => {
    psRan(2, '', 'usage: ps [-AaCcEefhjlMmrSTvwXx] [-O fmt | -o fmt] [-G gid[,gid...]]\n')
    kill.mockImplementation(() => {
      throw kernelError('ESRCH')
    })
    expect(queryProcessCommandLine(4242)).toEqual({ status: 'failed' })
  })

  it('keeps a ps that could not start failed', () => {
    spawn.run.mockReturnValue({ status: null, stdout: '', stderr: '', error: kernelError('ENOENT') })
    expect(queryProcessCommandLine(4242)).toEqual({ status: 'failed' })
  })

  it('reads the command line of a found process', () => {
    psRan(0, '/usr/local/bin/node /x/token-goat.mjs --worker-daemon\n', '')
    expect(queryProcessCommandLine(4242)).toEqual({ status: 'found', commandLine: '/usr/local/bin/node /x/token-goat.mjs --worker-daemon' })
  })
})

describe('classifyPosixPsRun', () => {
  const tooLarge = { status: 1, stdout: '', stderr: TOO_LARGE }

  it('leaves Linux alone: a stderr-bearing exit 1 is failed whatever the kernel says, and the kernel is not asked', () => {
    const asked = vi.fn(() => true)
    expect(classifyPosixPsRun(tooLarge, 'linux', asked)).toEqual({ status: 'failed' })
    expect(asked).not.toHaveBeenCalled()
  })

  it('reads the silent exit 1 as gone on Linux and on darwin', () => {
    for (const platform of ['linux', 'darwin'] as const) expect(classifyPosixPsRun({ status: 1, stdout: '', stderr: '' }, platform, () => false)).toEqual({ status: 'gone' })
  })

  it('asks the kernel only on darwin, and takes its yes as gone', () => {
    expect(classifyPosixPsRun(tooLarge, 'darwin', () => true)).toEqual({ status: 'gone' })
    expect(classifyPosixPsRun(tooLarge, 'darwin', () => false)).toEqual({ status: 'failed' })
  })
})
