/** The process lister behind cleanupTrees (tests/helpers/copilot_session_start_tree.ts). One COPILOT_CLI_HOOK_SCRIPT row failed in its after-hook on "process listing failed: " with nothing after the colon: the lister exited non-zero having printed nothing, which is a process that did not start, and the row had asserted nothing wrong. */
import { describe, expect, it } from 'vitest'

import { listProcesses, type ProcessListingLaunch } from './helpers/copilot_session_start_tree.js'

// HAND-DERIVED: one row in the format the platform's own lister prints (tab-separated on Windows, the columns of `ps -eo pid=,ppid=,args=` elsewhere), built from the parser's contract in listProcesses, not captured from a run.
const ROW = process.platform === 'win32' ? '4242\t17\tnode child.js\r\n' : ' 4242    17 node child.js\n'
const STARTED_AND_ANSWERED = { status: 0, signal: null, error: undefined, stdout: ROW, stderr: '' }
const NEVER_STARTED = { status: 3221225794, signal: null, error: undefined, stdout: '', stderr: '' }

function launches(...answers: Array<ReturnType<ProcessListingLaunch>>): { launch: ProcessListingLaunch; calls: () => number } {
  let called = 0
  return { launch: () => answers[Math.min(called++, answers.length - 1)], calls: () => called }
}

describe('listProcesses', () => {
  it('launches the lister again when a start printed nothing and exited non-zero, and uses the answer that follows', () => {
    const { launch, calls } = launches(NEVER_STARTED, STARTED_AND_ANSWERED)
    expect(listProcesses(launch).get(4242)).toEqual({ ppid: 17, args: 'node child.js' })
    expect(calls()).toBe(2)
  })

  it('gives up after three silent starts and names the status it saw', () => {
    const { launch, calls } = launches(NEVER_STARTED)
    expect(() => listProcesses(launch)).toThrow('process listing failed: status 3221225794')
    expect(calls()).toBe(3)
  })

  it('does not launch again for a lister that ran and said why it failed', () => {
    const { launch, calls } = launches({ status: 1, signal: null, error: undefined, stdout: '', stderr: 'Get-CimInstance : Access denied' })
    expect(() => listProcesses(launch)).toThrow('Access denied')
    expect(calls()).toBe(1)
  })

  it('does not launch again for a lister that could not be spawned', () => {
    const { launch, calls } = launches({ status: null, signal: null, error: new Error('spawn ENOENT'), stdout: '', stderr: '' })
    expect(() => listProcesses(launch)).toThrow('spawn ENOENT')
    expect(calls()).toBe(1)
  })
})
