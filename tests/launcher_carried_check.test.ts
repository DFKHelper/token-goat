// A launcher-carried check clears a failure. HAND-DERIVED; FORMAT: https://code.claude.com/docs/en/hooks

import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import {
  evaluateVerification,
  noteFailedVerificationRun,
  noteVerificationRun,
} from '../src/verification_state.js'

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)
const key = (): string => `s-launcher-${process.pid}-${Math.random().toString(36).slice(2)}`

afterEach(() => vi.unstubAllEnvs())

function inSession(sid: string, work: () => void): void {
  loadSessionState(sid)
  try {
    work()
  } finally {
    saveSessionState(sid)
  }
}

/** A session holding a failed `npm test`, then `work`; the result is whether that failure still stands. */
function failureStandsAfter(work: () => void): boolean {
  vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  const sid = key()
  inSession(sid, () => {
    recordFileEdit('C:/proj/src/a.ts')
    recordVerificationRun('npm test', 1, T0)
    work()
  })
  return evaluateVerification(sid).failingUnresolved
}

const LAUNCHED = 'python tool.py npx vitest run a.test.ts'

describe('a launcher-carried check', () => {
  it('a script that takes a command as plain arguments passing does not clear a failure', () => {
    expect(
      failureStandsAfter(() => noteVerificationRun('python notes.py add npm test', 0, false)),
      'cleared by notes.py',
    ).toBe(true)
  })

  it('a launcher line passing clears the failure it carries', () => {
    expect(
      failureStandsAfter(() => noteVerificationRun(LAUNCHED, 0, false)),
      'a launched pass cleared nothing',
    ).toBe(false)
  })

  // Ruling: a switch directly followed by a check is launcher-carried; a switch value between them is not.
  it('a switch directly followed by a check, passing, clears the failure', () => {
    expect(
      failureStandsAfter(() => noteVerificationRun('python notes.py --note npm test', 0, false)),
      'a switch directly before the check did not carry it',
    ).toBe(false)
  })

  it('a switch value between the switch and the check, passing, does not clear the failure', () => {
    expect(
      failureStandsAfter(() => noteVerificationRun('python x.py --timeout 5 npm test', 0, false)),
      'a switch value was guessed away and the check taken as carried',
    ).toBe(true)
  })

  it('the same line failing records nothing, from the failure event', () => {
    const sid = key()
    inSession(sid, () => noteFailedVerificationRun(LAUNCHED, 'Exit code 1', false))
    expect(evaluateVerification(sid).runs, 'a failure was booked for a launcher line').toEqual([])
  })

  it('the same line failing records nothing, from a failed status on the ordinary event', () => {
    const sid = key()
    inSession(sid, () => noteVerificationRun(LAUNCHED, 1, false))
    expect(evaluateVerification(sid).runs, 'a failure was booked for a launcher line').toEqual([])
  })
})
