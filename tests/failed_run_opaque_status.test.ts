// A failed call with a heredoc or process substitution is a failed check only when its exit status belongs to a check segment. Provenance: HAND-DERIVED from bash heredoc semantics (the status of a line is the status of its last command); "Exit code N" is FORMAT-DERIVED from the PostToolUseFailure error field of https://code.claude.com/docs/en/hooks.

import { describe, expect, it } from 'vitest'

import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { evaluateVerification, noteFailedVerificationRun } from '../src/verification_state.js'

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
    noteFailedVerificationRun(command, 'Exit code 1', false)
  } finally {
    saveSessionState(key)
  }
  return evaluateVerification(key).failingUnresolved
}

describe('a failed heredoc or substitution call after a passing check', () => {
  it("the owner's shape (a passing check, then a failing commit fed by a heredoc) records nothing", () => {
    const commit = "npm test; git commit -F - <<'EOF'\nmessage\nEOF"
    expect(failedCallRecords(commit), 'the commit failure was booked as a failed check').toBe(false)
  })

  it('the same shape joined with || records nothing, the commit may replace the check status', () => {
    expect(failedCallRecords("npm test || git commit -F - <<'EOF'\nmessage\nEOF"), 'status is the commit').toBe(false)
  })

  it('a process substitution after a check segment records nothing', () => {
    expect(failedCallRecords('npm test; diff <(echo a) <(echo b)'), 'status is the diff').toBe(false)
  })

  it('a heredoc feeding the check itself records', () => {
    expect(failedCallRecords("npx vitest run <<'EOF'\nbody\nEOF"), 'the check owns the status').toBe(true)
  })

  it('a check as the last segment of a line with an earlier heredoc records', () => {
    expect(failedCallRecords("cat <<'EOF' | wc -l\nbody\nEOF\nnpm test"), 'the last segment is the check').toBe(true)
  })

  it('a check that is the last segment after a process substitution records', () => {
    expect(failedCallRecords('diff <(echo a) <(echo b) && npm test'), 'the last segment is the check').toBe(true)
  })

  it('a check run by a shell the heredoc feeds records', () => {
    expect(failedCallRecords("bash <<'EOF'\nnpx vitest run tests/a.test.ts\nEOF"), 'the check ends the script').toBe(true)
  })
})
