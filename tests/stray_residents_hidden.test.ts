/** A node process whose command line Windows hides (an elevated process asked from a normal shell) may be a resident of this install, so retireStrayResidents never signals it and never reports a clean sweep over it: its pid comes back as unconfirmed, and the upgrade note names it. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DoctorProcessModule from '../src/cli_doctor_process.js'
import type * as ResidentProcessModule from '../src/resident_process.js'

const spies = vi.hoisted(() => ({ terminate: vi.fn(() => true), table: vi.fn() }))

vi.mock('../src/cli_doctor_process.js', async (importOriginal) => ({ ...(await importOriginal<typeof DoctorProcessModule>()), readAllProcesses: spies.table }))
vi.mock('../src/resident_process.js', async (importOriginal) => ({ ...(await importOriginal<typeof ResidentProcessModule>()), terminateProcessTree: spies.terminate }))

const { daemonEntryScript } = await import('../src/worker_lifecycle.js')
const { describeRetirement, retireStrayResidents } = await import('../src/stray_residents.js')

/** Above Linux pid_max (4194304) and macOS 99999, so no real process holds one; none is signalled either, since the kill above is replaced. */
const [LISTED, HIDDEN, SYSTEM] = [4_200_011, 4_200_012, 4_200_013]

const workerLine = (): string => `node ${daemonEntryScript()} --worker-daemon`
// FORMAT-DERIVED from src/cli_doctor_process.ts::readWindowsProcesses, which maps a row whose CommandLine is not a string (null for a process the caller may not inspect) to commandLine '' and keeps its Name; the 'node.exe' name is a daemon's executable on Windows.
const hiddenNode = (processId: number) => ({ processId, parentProcessId: 1, name: 'node.exe', commandLine: '' })
// HAND-DERIVED: an operating-system process with no command line at all, which every Windows list carries and which is no resident of any install.
const systemRow = (processId: number) => ({ processId, parentProcessId: 0, name: 'System', commandLine: '' })
const listedWorker = (processId: number) => ({ processId, parentProcessId: 1, name: 'node', commandLine: workerLine() })
const killed = (): number[] => spies.terminate.mock.calls.map((call) => (call as unknown as number[])[0]!)

beforeEach(() => {
  spies.terminate.mockClear()
  spies.table.mockReset()
})

describe('retireStrayResidents over a process whose command line is hidden', () => {
  it('reports a hidden node process as unconfirmed, signals nobody, and says so in the note', async () => {
    spies.table.mockReturnValue([hiddenNode(HIDDEN)])

    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: workerLine })

    expect(spies.terminate).not.toHaveBeenCalled()
    expect(report.unconfirmed).toEqual([HIDDEN])
    expect(report.retired).toEqual([])
    const note = describeRetirement(report)
    expect(note).toContain(`pid ${HIDDEN}`)
    expect(note).toContain('hides its command line')
    expect(note).toContain('not ended')
  })

  it('ends the listed worker beside a hidden one, and reports only the hidden one as unconfirmed', async () => {
    spies.table.mockReturnValue([listedWorker(LISTED), hiddenNode(HIDDEN)])

    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: workerLine })

    expect(killed()).toEqual([LISTED])
    expect(report.retired).toEqual([LISTED])
    expect(report.unconfirmed).toEqual([HIDDEN])
    expect(describeRetirement(report)).toContain(`pid ${LISTED}`)
    expect(describeRetirement(report)).toContain(`pid ${HIDDEN}`)
  })

  it('reports a pid whose command line turns hidden between the list and its kill, and does not signal it', async () => {
    spies.table.mockReturnValue([listedWorker(LISTED)])

    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: () => '' })

    expect(spies.terminate).not.toHaveBeenCalled()
    expect(report.retired).toEqual([])
    expect(report.unconfirmed).toEqual([LISTED])
    expect(describeRetirement(report)).toContain(`pid ${LISTED}`)
  })

  it('stays silent for an operating-system row with no command line, and for a pid whose line cannot be read at all', async () => {
    spies.table.mockReturnValue([systemRow(SYSTEM), listedWorker(LISTED)])

    const report = await retireStrayResidents({ kinds: ['worker'], deadlineMs: 1e12, readCommandLine: () => null })

    expect(spies.terminate).not.toHaveBeenCalled()
    expect(report.unconfirmed ?? []).toEqual([])
    expect(describeRetirement(report)).toBeNull()
  })
})
