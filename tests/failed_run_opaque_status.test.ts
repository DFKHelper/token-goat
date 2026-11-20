// A heredoc or <() call is a failed check only if its status is a check's. HAND-DERIVED from bash.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import {
  evaluateVerification,
  noteFailedVerificationRun,
  noteVerificationRun,
} from '../src/verification_state.js'

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

function newSession(): string {
  return `s-opaque-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** The latest verdict after a passing `npm test` and then one failed call carrying `command`. */
function failedCallRecords(command: string): boolean {
  const key = newSession()
  loadSessionState(key)
  try {
    recordFileEdit('C:/proj/src/a.ts')
    recordVerificationRun('npm test', 0, T0 + 1000)
    noteFailedVerificationRun(command, 'Exit code 1', false, undefined, T0 + 2000)
  } finally {
    saveSessionState(key)
  }
  return evaluateVerification(key).failingUnresolved
}

/** Whether a failed `npm test` is still unresolved after a passing call carrying `command`. */
function passingCallClears(command: string): boolean {
  const key = newSession()
  loadSessionState(key)
  try {
    recordFileEdit('C:/proj/src/a.ts')
    recordVerificationRun('npm test', 1, T0 + 1000)
    noteVerificationRun(command, 0, false, undefined, T0 + 2000)
  } finally {
    saveSessionState(key)
  }
  return !evaluateVerification(key).failingUnresolved
}

describe('a failed heredoc or substitution call after a passing check', () => {
  it("the owner's shape (a passing check, then a failing commit fed by a heredoc) records nothing", () => {
    const commit = "npm test; git commit -F - <<'EOF'\nmessage\nEOF"
    expect(failedCallRecords(commit), 'the commit failure was booked as a failed check').toBe(false)
  })

  it('the same shape joined with || records nothing, the commit may replace the check status', () => {
    expect(
      failedCallRecords("npm test || git commit -F - <<'EOF'\nmessage\nEOF"),
      'status is the commit',
    ).toBe(false)
  })

  it('a process substitution after a check segment records nothing', () => {
    expect(failedCallRecords('npm test; diff <(echo a) <(echo b)'), 'status is the diff').toBe(false)
  })

  it('a heredoc feeding the check itself records', () => {
    expect(failedCallRecords("npx vitest run <<'EOF'\nbody\nEOF"), 'the check owns the status').toBe(true)
  })

  it('a check as the last segment of a line with an earlier heredoc records', () => {
    expect(
      failedCallRecords("cat <<'EOF' | wc -l\nbody\nEOF\nnpm test"),
      'the last segment is the check',
    ).toBe(true)
  })

  it('a check after a process substitution joined by && records nothing on a failure', () => {
    expect(
      failedCallRecords('diff <(echo a) <(echo b) && npm test'),
      'the diff may be what failed, so the check is not blamed',
    ).toBe(false)
  })

  it('the same call exiting 0 still clears an earlier failure of the check', () => {
    expect(
      passingCallClears('diff <(echo a) <(echo b) && npm test'),
      'a pass of the whole chain means the check passed',
    ).toBe(true)
  })

  it('a check run by a shell the heredoc feeds records', () => {
    expect(
      failedCallRecords("bash <<'EOF'\nnpx vitest run tests/a.test.ts\nEOF"),
      'the check ends the script',
    ).toBe(true)
  })
})

describe('a failed and-chain blames a check only when the check ends it', () => {
  it.each([
    ['an earlier operand that is not a check fails first', 'false && npm test'],
    ['the check passed and a later operand failed', 'npm test && false'],
    ['an install is not a check', 'npm ci && npm test'],
  ])('%s: %s records nothing', (_why, command) => {
    expect(failedCallRecords(command), 'the failure was blamed on a check that may not have run').toBe(false)
  })

  it.each([
    ['a lone check', 'npm test'],
    ['a plain cd before the check', 'cd pkg && npm test'],
    ['an earlier check before the last one', 'npm run lint && npm test'],
  ])('%s: %s records', (_why, command) => {
    expect(failedCallRecords(command), 'a real failing check went unrecorded').toBe(true)
  })

  it('a pass of an install-then-test chain still clears an earlier failure', () => {
    expect(passingCallClears('npm ci && npm test'), 'the pass rule must stay as it was').toBe(true)
  })
})

describe('the verdict order does not depend on the host clock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a failure after a seeded pass records with the system time faked to 2020', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2020, 0, 1)))
    expect(failedCallRecords('npm test'), 'the failure took the faked clock, not its time').toBe(true)
  })
})
