// A POSIX SIGKILL ends a process only when the kernel has let it go, so a kill reports done only after the pid is observed gone. Provenance: HAND-DERIVED from the rule (a SIGKILLed pid answers signal 0 until it is reaped), with the probe count injected through kill_spy.ts; the pause between checks is mocked, so no clock is read.
import type * as ProcessUtilModule from '../src/process_util.js'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type KillSpy, spyProcessKill } from './helpers/kill_spy.js'

vi.mock('../src/process_util.js', async (importOriginal) => {
  const real = await importOriginal<typeof ProcessUtilModule>()
  return { ...real, sleepSync: () => undefined }
})

const { terminateProcessTree } = await import('../src/resident_process.js')

const TARGET = 987654

let spy: KillSpy | undefined

afterEach(() => {
  spy?.restore()
  spy = undefined
  vi.restoreAllMocks()
})

describe.skipIf(process.platform === 'win32')('terminateProcessTree with a SIGKILL reports done only once the pid is gone', () => {
  it('answers true only after the pid has been probed and seen gone', () => {
    spy = spyProcessKill({ probesBeforeGone: 2 })
    expect(terminateProcessTree(TARGET, true)).toBe(true)
    const probes = spy.calls.filter((call) => call.pid === TARGET && call.signal === 0)
    expect(probes, 'the pid was probed alive twice before the gone answer').toHaveLength(3)
  })

  it('answers false and names the pid when it is still running past the bounded checks', () => {
    spy = spyProcessKill({ probesBeforeGone: Infinity })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(terminateProcessTree(TARGET, true), 'a pid never seen gone is not reported ended').toBe(false)
    expect(stderr.mock.calls.map((call) => String(call[0])).join(''), 'the survivor is named on stderr').toContain(`pid ${TARGET} still running after SIGKILL`)
  })

  it('a SIGTERM is accepted without probing the pid, so it does not wait', () => {
    spy = spyProcessKill({ probesBeforeGone: Infinity })
    expect(terminateProcessTree(TARGET, false), 'a graceful stop is reported as accepted').toBe(true)
    expect(spy.calls.filter((call) => call.signal === 0), 'no probe follows a SIGTERM').toEqual([])
  })
})
