// A pass of a heredoc-fed check clears its earlier failure. HAND-DERIVED from bash heredoc syntax.

import { describe, expect, it } from 'vitest'

import { recordFileEdit, recordVerificationRun } from '../src/session.js'
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
function failThenPass(
  command: string,
): { failedAlone: boolean; unresolvedAfterPass: boolean; exitCodes: Array<number | null> } {
  const key = newSession()
  loadSessionState(key)
  recordFileEdit('C:/proj/src/a.ts')
  noteFailedVerificationRun(command, 'Exit code 1', false)
  saveSessionState(key)
  const failedAlone = evaluateVerification(key).failingUnresolved
  loadSessionState(key)
  noteVerificationRun(command, 0, false)
  saveSessionState(key)
  const after = evaluateVerification(key)
  return {
    failedAlone,
    unresolvedAfterPass: after.failingUnresolved,
    exitCodes: after.runs.map((r) => r.exitCode),
  }
}

describe('a pass of a heredoc-fed check', () => {
  it.each([
    ['quoted', "bash <<'EOF'\nnpm test\nEOF"],
    ['unquoted', 'sh <<EOF\nnpm test\nEOF'],
  ])('clears the failure of the same %s heredoc command', (_form, command) => {
    const result = failThenPass(command)
    expect(result.failedAlone, 'the failure side must record this form for the row to mean anything').toBe(true)
    expect(result.unresolvedAfterPass, 'the pass left the stale failure standing').toBe(false)
    expect(result.exitCodes, 'the stored record was not replaced by the pass').toEqual([0])
  })
})

/** The session's records after a failure of `failed` and then a pass of `passed`, saved and reloaded between the two. */
function failThenPassOther(
  failed: string,
  passed: string,
): { unresolved: boolean; exitCodes: Array<number | null>; stored: string } {
  const key = newSession()
  loadSessionState(key)
  recordFileEdit('C:/proj/src/a.ts')
  noteFailedVerificationRun(failed, 'Exit code 1', false)
  saveSessionState(key)
  loadSessionState(key)
  noteVerificationRun(passed, 0, false)
  saveSessionState(key)
  const state = evaluateVerification(key)
  return {
    unresolved: state.failingUnresolved,
    exitCodes: state.runs.map((r) => r.exitCode),
    stored: JSON.stringify(state.runs),
  }
}

const withBody = (body: string): string => `cat > notes.txt <<'EOF'\n${body}\nEOF\nnpm test`

describe('two heredoc inputs to one check are two records', () => {
  it('a pass with another body leaves the failure standing, and no body text is stored', () => {
    const result = failThenPassOther(withBody('body-alpha-secret'), withBody('body-beta-secret'))
    expect(result.unresolved, 'a pass with body B cleared the failure with body A').toBe(true)
    expect(result.exitCodes, 'the two bodies shared one record').toEqual([1, 0])
    expect(result.stored, 'a heredoc body reached the stored record').not.toMatch(/secret/)
  })

  it('a pass with the same body clears the failure and leaves one record', () => {
    const result = failThenPassOther(withBody('body-alpha-secret'), withBody('body-alpha-secret'))
    expect(result.unresolved, 'the same input passing did not clear its failure').toBe(false)
    expect(result.exitCodes, 'the same body made two records').toEqual([0])
  })

  it('a record written before bodies were fingerprinted still compares by its command alone', () => {
    const key = newSession()
    loadSessionState(key)
    recordFileEdit('C:/proj/src/a.ts')
    recordVerificationRun('npm test', 1)
    noteVerificationRun('npm test', 0, false)
    saveSessionState(key)
    expect(evaluateVerification(key).failingUnresolved, 'a plain pass left a plain failure').toBe(false)
  })
})
