// A pass of a heredoc-fed check clears its earlier failure. HAND-DERIVED from bash heredoc syntax.

import { describe, expect, it } from 'vitest'

import { recordFileEdit } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import {
  evaluateVerification,
  noteFailedVerificationRun,
  noteVerificationRun,
} from '../src/verification_state.js'

function newSession(): string {
  return `s-heredoc-pass-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** The verdict after one failure of `command` and then one pass of the same command. */
function failThenPass(command: string): { failedAlone: boolean; unresolvedAfterPass: boolean } {
  const key = newSession()
  loadSessionState(key)
  recordFileEdit('C:/proj/src/a.ts')
  noteFailedVerificationRun(command, 'Exit code 1', false)
  saveSessionState(key)
  const failedAlone = evaluateVerification(key).failingUnresolved
  loadSessionState(key)
  noteVerificationRun(command, 0, false)
  saveSessionState(key)
  return { failedAlone, unresolvedAfterPass: evaluateVerification(key).failingUnresolved }
}

describe('a pass of a heredoc-fed check', () => {
  it.each([
    ['quoted', "bash <<'EOF'\nnpm test\nEOF"],
    ['unquoted', 'sh <<EOF\nnpm test\nEOF'],
  ])('clears the failure of the same %s heredoc command', (_form, command) => {
    const result = failThenPass(command)
    expect(result.failedAlone, 'the failure side must record this form for the row to mean anything').toBe(true)
    expect(result.unresolvedAfterPass, 'the pass left the stale failure standing').toBe(false)
  })
})
