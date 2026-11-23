// A heredoc or <() call is a failed check only if its status is a check's. HAND-DERIVED from bash.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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
function failedCallRecords(command: string, cwd?: string): boolean {
  const key = newSession()
  loadSessionState(key)
  try {
    recordFileEdit('C:/proj/src/a.ts')
    recordVerificationRun('npm test', 0, T0 + 1000)
    noteFailedVerificationRun(command, 'Exit code 1', false, cwd, T0 + 2000)
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
    ['an earlier check before the last one', 'npm run lint && npm test'],
  ])('%s: %s records', (_why, command) => {
    expect(failedCallRecords(command), 'a real failing check went unrecorded').toBe(true)
  })

  it('a pass of an install-then-test chain still clears an earlier failure', () => {
    expect(passingCallClears('npm ci && npm test'), 'the pass rule must stay as it was').toBe(true)
  })
})

let work = ''
beforeAll(() => {
  // The OS spelling, not os.tmpdir()'s: a Windows runner's temp dir is a RUNNER~1 short name, and enteredDirectory treats any `~` in a cd target as an expansion it cannot resolve, so the absolute-target row would see no directory.
  work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx24-'))).split(path.sep).join('/')
  fs.mkdirSync(path.join(work, 'pkg', 'sub'), { recursive: true })
})
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

describe('a failed cd chain blames the check only when the cd is shown to have succeeded', () => {
  it.each([
    ['a plain cd into a directory that exists', 'cd pkg && npm test', true],
    ['two cds that both exist, the second resolved from the first', 'cd pkg && cd sub && npm test', true],
    ['a cd into a directory that is missing', 'cd missing && npm test', false],
    ['a second cd that exists only beside the first, not inside it', 'cd pkg && cd pkg && npm test', false],
    ['a cd to the previous directory cannot be resolved', 'cd - && npm test', false],
  ])('%s: %s', (_why, command, recorded) => {
    expect(failedCallRecords(command, work), 'the cd failure was blamed on the check').toBe(recorded)
  })

  it('a relative cd with no known working directory records nothing', () => {
    expect(failedCallRecords('cd pkg && npm test'), 'the target could not be shown to exist').toBe(false)
  })

  it('an absolute cd needs no working directory', () => {
    expect(failedCallRecords(`cd ${work}/pkg && npm test`), 'an existing absolute target').toBe(true)
  })
})

describe('a pipefail failure is the check status only when later stages cannot fail on its output', () => {
  it.each([
    ['tail only copies', 'set -o pipefail; npm test | tail -5', true],
    ['cat only copies', 'set -o pipefail; npm test 2>&1 | cat', true],
    ['grep -q fails on no match', 'set -o pipefail; npm test | grep -q x', false],
    ['head closes the pipe early', 'set -o pipefail; npm test | head -1', false],
    ['one stage in the table then one outside it', 'set -o pipefail; npm test | tail | grep x', false],
  ])('%s: %s', (_why, command, recorded) => {
    expect(failedCallRecords(command), 'a later pipe stage may be what failed').toBe(recorded)
  })
})

describe('a failure whose status is provably the check status is recorded', () => {
  it.each([
    ['an || before the check: a non-zero exit means the check ran', 'false || npm test', true],
    ['errexit, then a later echo that cannot fail', 'set -e; npm test; echo done', true],
    ['errexit, then a later check', 'set -e; npm test && npm run lint', true],
    ['errexit and a later statement that can fail', 'set -e; npm test; git commit -m x', false],
    ['errexit and an earlier statement that can fail', 'set -e; git add x; npm test', false],
    ['errexit turned off again', 'set -e; set +e; npm test; echo done', false],
    ['no errexit: the echo decides the status', 'npm test; echo done', false],
    ['a subshell around the check', '(npm test)', true],
  ])('%s: %s', (_why, command, recorded) => {
    expect(failedCallRecords(command), 'the failure was dropped or blamed wrongly').toBe(recorded)
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
