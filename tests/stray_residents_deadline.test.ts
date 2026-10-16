/** retireStrayResidents ends its matches one after another, and on Windows each end is a taskkill of up to resident_process.ts::PROCESS_QUERY_TIMEOUT_MS; one total deadline of that same size stops the loop and reports the rest instead of waiting through hundreds of calls. The real matcher and the real retire loop run; the process table and the kill are replaced, because a pid in the table must be a process this test never started and must never be signalled. The deadline is passed as 0 (already past) or as a bound that cannot pass, so nothing here measures elapsed time. Fixtures are HAND-DERIVED: rows in the shape cli_doctor_process.ts::ProcessInfo declares, command lines `node <launcher> --worker-daemon` as resident_process.ts::isResidentOfInstall documents. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DoctorProcessModule from '../src/cli_doctor_process.js'
import type * as ResidentProcessModule from '../src/resident_process.js'

const spies = vi.hoisted(() => ({ terminate: vi.fn(() => true), table: vi.fn() }))

vi.mock('../src/cli_doctor_process.js', async (importOriginal) => ({ ...(await importOriginal<typeof DoctorProcessModule>()), readAllProcesses: spies.table }))
vi.mock('../src/resident_process.js', async (importOriginal) => ({ ...(await importOriginal<typeof ResidentProcessModule>()), terminateProcessTree: spies.terminate }))

const { daemonEntryScript } = await import('../src/worker_lifecycle.js')
const { describeRetirement, retireStrayResidents } = await import('../src/stray_residents.js')

/** Above Linux pid_max (4194304) and macOS 99999, so no real process holds one; none is signalled either, since the kill above is replaced. */
const PIDS = [4_200_001, 4_200_002, 4_200_003]

beforeEach(() => {
  spies.terminate.mockClear()
  spies.table.mockReturnValue(PIDS.map((processId) => ({ processId, parentProcessId: 1, name: 'node', commandLine: `node ${daemonEntryScript()} --worker-daemon` })))
})

describe('retireStrayResidents deadline', () => {
  it('signals nobody past the deadline and reports every match it left', async () => {
    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 0 })

    expect(spies.terminate).not.toHaveBeenCalled()
    expect(report.notTried).toEqual(PIDS)
    expect(report.survivors).toEqual(PIDS)
    expect(report.retired).toEqual([])
    expect(describeRetirement(report)).toContain(`pid ${PIDS.join(', ')} were left running`)
  })

  it('signals every match when the deadline does not pass', async () => {
    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12 })

    expect(spies.terminate.mock.calls.map((call) => (call as unknown as number[])[0])).toEqual(PIDS)
    expect(report.notTried).toEqual([])
    expect(report.retired).toEqual(PIDS)
  })
})
