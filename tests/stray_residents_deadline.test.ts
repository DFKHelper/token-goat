/** retireStrayResidents ends its matches one after another, and on Windows each end is a taskkill of up to resident_process.ts::PROCESS_QUERY_TIMEOUT_MS; one total deadline of that same size stops the loop and reports the rest instead of waiting through hundreds of calls. The real matcher and the real retire loop run; the process table and the kill are replaced, because a pid in the table must be a process this test never started and must never be signalled. The deadline is passed as 0 (already past) or as a bound that cannot pass, so nothing here measures elapsed time. The command-line re-read before each kill is injected (a pid reused since the list is skipped), and the kinds upgrade passes are pinned. Fixtures are HAND-DERIVED: rows in the shape cli_doctor_process.ts::ProcessInfo declares, command lines `node <launcher> --worker-daemon` as resident_process.ts::isResidentOfInstall documents. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DoctorProcessModule from '../src/cli_doctor_process.js'
import type * as ResidentProcessModule from '../src/resident_process.js'

const spies = vi.hoisted(() => ({ terminate: vi.fn(() => true), table: vi.fn() }))

vi.mock('../src/cli_doctor_process.js', async (importOriginal) => ({ ...(await importOriginal<typeof DoctorProcessModule>()), readAllProcesses: spies.table }))
vi.mock('../src/resident_process.js', async (importOriginal) => ({ ...(await importOriginal<typeof ResidentProcessModule>()), terminateProcessTree: spies.terminate }))

const { daemonEntryScript } = await import('../src/worker_lifecycle.js')
const { UPGRADE_RESIDENT_KINDS, describeRetirement, retireStrayResidents } = await import('../src/stray_residents.js')

/** Above Linux pid_max (4194304) and macOS 99999, so no real process holds one; none is signalled either, since the kill above is replaced. */
const PIDS = [4_200_001, 4_200_002, 4_200_003]

const workerLine = (): string => `node ${daemonEntryScript()} --worker-daemon`
const hookServerLine = (): string => `node ${daemonEntryScript()} hook-server run --slot 1`
const row = (processId: number, commandLine: string) => ({ processId, parentProcessId: 1, name: 'node', commandLine })
const killed = (): number[] => spies.terminate.mock.calls.map((call) => (call as unknown as number[])[0]!)

beforeEach(() => {
  spies.terminate.mockClear()
  spies.table.mockReturnValue(PIDS.map((processId) => row(processId, workerLine())))
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
    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: workerLine })

    expect(killed()).toEqual(PIDS)
    expect(report.notTried).toEqual([])
    expect(report.retired).toEqual(PIDS)
  })
})

describe('retireStrayResidents just before each kill', () => {
  it('skips a pid whose command line no longer matches this install, though the list showed it', async () => {
    // The table says all three are daemons; by the time the loop reaches the second, the OS has given its pid to an unrelated process.
    const lines = new Map<number, string>([[PIDS[0]!, workerLine()], [PIDS[1]!, 'node C:/elsewhere/other.js --worker-daemon'], [PIDS[2]!, workerLine()]])
    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: (pid) => lines.get(pid) ?? null })

    expect(killed()).toEqual([PIDS[0], PIDS[2]])
    expect(report.retired).toEqual([PIDS[0], PIDS[2]])
  })

  it('skips a pid whose command line can no longer be read', async () => {
    await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: () => null })

    expect(killed()).toEqual([])
  })
})

describe('what upgrade ends', () => {
  it('names both resident kinds, so a hook server of this install is ended as well as a worker', async () => {
    spies.table.mockReturnValue([row(PIDS[0]!, workerLine()), row(PIDS[1]!, hookServerLine()), row(PIDS[2]!, 'node C:/elsewhere/other.js hook-server run')])
    const lines = new Map<number, string>([[PIDS[0]!, workerLine()], [PIDS[1]!, hookServerLine()]])

    await retireStrayResidents({ kinds: UPGRADE_RESIDENT_KINDS, deadlineMs: 1e12, readCommandLine: (pid) => lines.get(pid) ?? null })

    expect(killed()).toEqual([PIDS[0], PIDS[1]])
  })
})
