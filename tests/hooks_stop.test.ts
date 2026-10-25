// The Stop advisory and the verification verdict it reads. Provenance: the Stop payloads are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (Stop: session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active, last_assistant_message) and https://developers.openai.com/codex/hooks (Stop: the common fields plus turn_id, stop_hook_active, last_assistant_message), the same docs tests/fixtures/harness_hook_payloads.ts cites. The failure text "Exit code 1" is FORMAT-DERIVED from the PostToolUseFailure error field of the Claude Code hooks doc (a Bash failure opens with `Exit code N`). Every expected verdict is HAND-DERIVED from the order of the edits and runs the test performs.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { receiptLines } from '../src/agent_receipt.js'
import { stopAdvisoryText, stopHandler } from '../src/hooks_stop.js'
import { mayBeVerificationCommand } from '../src/hooks_verification.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState, sessionSidecarPath } from '../src/session_store.js'
import { evaluateVerification, isVerificationCommand, noteFailedVerificationRun, noteVerificationRun } from '../src/verification_state.js'
import { makeHookEvent } from './helpers/hook-event.js'

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

function newSession(): string {
  return `s-stop-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, work, save, as relay.ts runs a hook, so the verdict is read back from disk. */
function inSession(key: string, work: () => void): void {
  loadSessionState(key)
  try {
    work()
  } finally {
    saveSessionState(key)
  }
}

const stopEvent = (sessionId: string, raw: Record<string, unknown> = {}, agentId?: string) =>
  makeHookEvent({ eventName: 'stop', toolName: undefined, sessionId, agentId, raw: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.', ...raw } })

describe('isVerificationCommand', () => {
  // HAND-DERIVED: commands a developer types to test, lint, typecheck or build, and ones that prove nothing about an edit.
  it.each([
    ['npm test', true],
    ['npx vitest run tests/a.test.ts', true],
    ['npm run typecheck', true],
    ['npx tsc --noEmit', true],
    ['cargo test', true],
    ['go vet ./...', true],
    ['cd app && FOO=1 pytest -x', true],
    ['npx eslint src', true],
    ['npm install', false],
    ['git status', false],
    ['ls -la', false],
    ['cat package.json', false],
  ])('%s -> %s', (command, expected) => {
    expect(isVerificationCommand(command)).toBe(expected)
  })
})

describe('mayBeVerificationCommand', () => {
  // HAND-DERIVED: one command per accepting rule in verification_state.ts (the test-runner, lint and OTHER_VERIFICATION_PATTERNS lists), so the keyword gate cannot be narrower than the verdict it guards.
  it.each([
    'pytest -x', 'npx jest', 'vitest run', 'go test ./...', 'cargo test', 'dotnet test', 'npm run test', 'yarn test', 'pnpm run test', 'eslint src', 'npx eslint .', 'ruff check .', 'uv run ruff format',
    'python scripts/validate-skills.py', 'python scripts/run_self_tests.py', 'python scripts/x.py --self-test', 'python scripts/check_push_bumps.py', 'tsc', 'npx tsc --noEmit', 'npm run build', 'pnpm typecheck', 'yarn run type-check', 'npm run check', 'npm run compile', 'npm run verify', 'npm run lint:fix', 'cargo build', 'cargo check', 'cargo clippy', 'go build ./...', 'go vet ./...', 'dotnet build', 'mypy src', 'pyright', 'python -m mypy src', 'python3 -m pytest', 'python -m ruff check',
  ])('lets %j through', (command) => {
    expect(isVerificationCommand(command)).toBe(true)
    expect(mayBeVerificationCommand(command)).toBe(true)
  })

  it('turns away a command no check could be', () => {
    expect(mayBeVerificationCommand('git status')).toBe(false)
    expect(mayBeVerificationCommand('ls -la src')).toBe(false)
  })
})

describe('evaluateVerification', () => {
  beforeEach(() => {
    clearModuleCaches()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('an edit with no verification run is unverified', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/a.ts'))
    const state = evaluateVerification(sid)
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
    expect(state.latestRun).toBeUndefined()
  })

  it('a passing run after the edit covers it', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 0, T0 + 1000)
    })
    const state = evaluateVerification(sid)
    expect(state.editedSinceLastPass).toEqual([])
    expect(state.failingUnresolved).toBe(false)
  })

  // HAND-DERIVED: Codex records no exit status for a shell run, so a null status after the edit must count as a check that ran.
  it('a run with no recorded status after the edit covers it', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', null, T0 + 1000)
    })
    expect(evaluateVerification(sid).editedSinceLastPass).toEqual([])
  })

  it('an edit after the last passing run is unverified again', () => {
    const sid = newSession()
    inSession(sid, () => recordVerificationRun('npm test', 0, T0 - 1000))
    vi.setSystemTime(T0 + 5000)
    inSession(sid, () => recordFileEdit('C:/proj/src/b.ts'))
    expect(evaluateVerification(sid).editedSinceLastPass).toEqual(['b.ts'])
  })

  it('a failing last run is unresolved even when no edit follows it', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 1, T0 + 1000)
    })
    const state = evaluateVerification(sid)
    expect(state.failingUnresolved).toBe(true)
    expect(state.latestRun?.exitCode).toBe(1)
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
  })

  it('a docs edit is not a source edit', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/README.md'))
    expect(evaluateVerification(sid).editedFiles).toEqual([])
  })

  it('a subagent is judged on its own key, not the parent session', () => {
    const sid = newSession()
    const agentKey = `${sid}:agent:sub1`
    inSession(sid, () => recordFileEdit('C:/proj/src/parent.ts'))
    inSession(agentKey, () => recordVerificationRun('npm test', 0, T0 + 1000))
    expect(evaluateVerification(sid).editedSinceLastPass).toEqual(['parent.ts'])
    expect(evaluateVerification(agentKey).editedFiles).toEqual([])
  })
})

describe('noteVerificationRun and noteFailedVerificationRun', () => {
  beforeEach(() => {
    clearModuleCaches()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function runsAfter(work: () => void): readonly { command: string; exitCode: number | null }[] {
    const sid = newSession()
    inSession(sid, work)
    return evaluateVerification(sid).runs
  }

  it('records a finished verification command and ignores everything else', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const runs = runsAfter(() => {
      noteVerificationRun('npm test', null, false)
      noteVerificationRun('git status', 0, false)
      noteVerificationRun('npm run build', 0, true)
    })
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([['npm test', 0]])
  })

  it('leaves the status unknown on a harness whose ordinary post event may carry a failure', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'codex')
    const runs = runsAfter(() => noteVerificationRun('npm test', null, false))
    expect(runs[0]?.exitCode).toBeNull()
  })

  it('reads the exit status out of a Bash failure and skips an interrupt', () => {
    const runs = runsAfter(() => {
      noteFailedVerificationRun('npm test', 'Exit code 2\nFAIL tests/a.test.ts', false)
      noteFailedVerificationRun('npm run lint', 'Exit code 1', true)
    })
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([['npm test', 2]])
  })

  // HAND-DERIVED from the ruling that a `.md` document is never a check input: a failing check script given only documents is a failure worth recording, with its command as typed and no document read as a verdict.
  it('records a failing check script whose only positional is a .md document, with its command and status', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const command = 'python scripts/run_self_tests.py README.md'
    expect(mayBeVerificationCommand(command)).toBe(true)
    const runs = runsAfter(() => {
      noteFailedVerificationRun(command, 'Exit code 1', false)
      noteVerificationRun('npm run lint README.md', 1, false)
    })
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([
      [command, 1],
      ['npm run lint README.md', 1],
    ])
  })

  // HAND-DERIVED: a `.md` positional is never a check input. A pass on a document-only check clears nothing, and a flag beside the document or a script whose name does not check leaves the run unrecorded even when it fails.
  it.each([
    ['python scripts/run_self_tests.py README.md', (c: string) => noteVerificationRun(c, 0, false)],
    ['python scripts/run_self_tests.py README.md', (c: string) => noteVerificationRun(c, null, false)],
    ['python scripts/run_self_tests.py README.md --verbose', (c: string) => noteFailedVerificationRun(c, 'Exit code 1', false)],
    ['python scripts/x.py README.md', (c: string) => noteFailedVerificationRun(c, 'Exit code 1', false)],
    ['python scripts/x.py README.md', (c: string) => noteVerificationRun(c, 1, false)],
  ])('does not take %j as a check run, and an edit before it stays unverified', (command, write) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('/p/src/a.ts')
      write(command)
    })
    const state = evaluateVerification(sid)
    expect(state.runs).toEqual([])
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
  })

  // HAND-DERIVED from shell semantics: the exit status of a list is the last command's, a pipeline's is its last stage's unless pipefail is set, and `||` / `;` let a later command replace the status.
  it.each([
    ['npm test 2>&1 | tail -30'],
    ['npm test || true'],
    ['npm test; echo done'],
    ['npm test\necho done'],
    ['false || npm test'],
    ['npm test | tee out.log'],
    ['npm test && npm run build | tail'],
    ['npm test &'],
    ['npm test & echo done'],
    ['npm test > out.log 2>&1 &'],
    ['npm test | tail # set -o pipefail'],
    ['echo set -o pipefail; npm test | tail'],
    ['# set -o pipefail\nnpm test | tail'],
    ['npm test | tail; set -o pipefail'],
    ['set -o pipefail; set +o pipefail; npm test | tail'],
    ['set -eo pipefail; set +o pipefail\nnpm test | tail'],
  ])('does not book %j as a pass', (command) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('/p/src/a.ts')
      noteVerificationRun(command, 0, false)
    })
    const state = evaluateVerification(sid)
    expect(state.runs).toEqual([])
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
  })

  it.each([['npm test'], ['npm test && echo ok'], ['cd app && npm test'], ['npm run build && npm test'], ['set -o pipefail; npm test | tail -5'], ['set -eo pipefail; npm test | tail -5'], ['set -euo pipefail\nnpm test 2>&1 | tail -5'], ['set -e -o pipefail && npm test | tail'], ['npm test;'], ['npm test 2>&1'], ['npm test &> out.log'], ['npm test >&2'], ['npm test 2>&1 && echo ok'], ['sleep 1 & npm test'], ['set -o pipefail; npm test |& tail'], ['set +o pipefail; set -o pipefail; npm test | tail']])('still books %j as a pass', (command) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const runs = runsAfter(() => noteVerificationRun(command, 0, false))
    expect(runs.map((r) => r.exitCode)).toEqual([0])
  })

  it('stores the command redacted', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const runs = runsAfter(() => noteVerificationRun(`GH_TOKEN=${secret} npm test`, 0, false))
    expect(runs[0]?.command).not.toContain(secret)
  })
})

describe('stored command credentials', () => {
  // HAND-DERIVED: shapes the global patterns in secret_redact.ts miss, which are the point (a name that says it is a secret, a flag that takes one). The values are made up.
  it.each([
    ['API_TOKEN=abcd1234efgh5678ijkl npm test', 'abcd1234efgh5678ijkl'],
    ['DB_PASSWORD="pass-word-1" npm test', 'pass-word-1'],
    ['export SECRET_KEY=zzzz1111 && npm test', 'zzzz1111'],
    ['npm test --password hunter2', 'hunter2'],
    ['npm test --token=tok123456', 'tok123456'],
    ["npm test --api-key 'k e y 1'", 'k e y 1'],
    ['npm test -u admin:s3cretpw', 's3cretpw'],
    ['DB_PASS=hunter2 npm test', 'hunter2'],
    ['npm test --db-password=abc12345', 'abc12345'],
    ['npm test --client-secret=abc12345', 'abc12345'],
    ['npm test --secret-key=abc12345', 'abc12345'],
    ['npm test --access-token abc12345', 'abc12345'],
    ['npm test --auth abc12345', 'abc12345'],
    ['mysql -phunter2 -e x && npm test', 'hunter2'],
    ['mysql -p hunter2 -e x && npm test', 'hunter2'],
    ['curl -H "Authorization: abc12345" x && npm test', 'abc12345'],
    ["curl -H 'Cookie: sid=abc12345' x && npm test", 'abc12345'],
    ['api_token=abc12345 npm test', 'abc12345'],
    ['DB_PASSWD=abc12345 npm test', 'abc12345'],
    ['AWS_CREDENTIAL=abc12345 npm test', 'abc12345'],
    ['npm test --passwd abc12345', 'abc12345'],
    ['npm test --apikey abc12345', 'abc12345'],
    ['npm test --secret abc12345', 'abc12345'],
    ['AUTH_HEADER=abc12345 npm test', 'abc12345'],
    ['SESSION_COOKIE=abc12345 npm test', 'abc12345'],
  ])('masks the secret in %j', (command, secret) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun(command, 0, false))
    const stored = evaluateVerification(sid).runs[0]?.command ?? ''
    expect(stored).not.toContain(secret)
    expect(stored).toContain('npm test')
  })

  it('keeps the check and drops its leading assignments, which are not part of what ran', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun('NODE_ENV=test CI=1 npm test', 0, false))
    expect(evaluateVerification(sid).runs[0]?.command).toBe('npm test')
  })

  // HAND-DERIVED: every spelling a reviewer found leaking through the secret-shape lists, each with `hunter2` as the value. The ones before `npm test` are not part of the check and must never be stored; the flags on the check itself go through the mask.
  it.each([
    ['GITHUB_PAT=hunter2 npm test'],
    ['DB_PWD=hunter2 npm test'],
    ['export GH_PAT=hunter2 && npm test'],
    ['npm test --passphrase hunter2'],
    ['npm test --private-key hunter2'],
    ['npm test --key hunter2'],
    ['npm test --bearer hunter2'],
    ['npm test --pwd hunter2'],
    ['npm test --credentials hunter2'],
    ['npm test --pass hunter2'],
    ['npm test --pass=hunter2'],
    ['mysqldump -phunter2 db && npm test'],
    ['pg_dump -W hunter2 db && npm test'],
    ['redis-cli -a hunter2 ping && npm test'],
    ['sshpass -p hunter2 ssh h; npm test'],
    ['curl -H "X-Auth-Token: hunter2" u && npm test'],
    ['X=hunter2 mysqldump -phunter2 db && npm test'],
    ['echo hunter2\nnpm test'],
  ])('lets hunter2 reach neither the session blob, the receipt nor the Stop advisory from %j', (command) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun(command, 1, false))
    const state = evaluateVerification(sid)
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]?.command).toContain('npm test')
    const blob = fs.readFileSync(sessionSidecarPath(sid, '.json') ?? '', 'utf8')
    expect([blob, receiptLines(state, false).join('\n'), stopAdvisoryText(state) ?? '']).toSatisfy((texts: string[]) => texts.every((t) => !t.includes('hunter2')))
    expect(receiptLines(state, false).join('\n')).toContain('npm test')
  })

  // HAND-DERIVED: each command with `hunter2` ON the check line itself, written from the spec (the runner and subcommand, the documented switches and path-like words are kept; every other word is dropped and marked with an ellipsis), not from the allow-list's code. The first group is every form the second re-review stored verbatim; the second is the header and flag forms from earlier rounds. Both writers, the finished-run and the failed-run path, run every row.
  const STORED_ROWS: ReadonlyArray<readonly [string, string]> = [
    ['npx vitest --env=TOKEN=hunter2', 'npx vitest …'],
    ['npm test -p hunter2', 'npm test …'],
    ['npm test -t hunter2', 'npm test …'],
    ['npm test -e hunter2', 'npm test …'],
    ['npm test --foo hunter2', 'npm test …'],
    ['npm test --sessionid hunter2', 'npm test …'],
    ['npm test --foo=hunter2', 'npm test …'],
    ['npm test hunter2', 'npm test …'],
    ['npm test "hunter2"', 'npm test …'],
    ['npm test -- hunter2', 'npm test -- …'],
    ['cargo test --features hunter2', 'cargo test …'],
    ['npm test --ci hunter2', 'npm test --ci …'],
    ['npm test hunter2 --ci', 'npm test --ci …'],
    ['npm test -p hunter2/x.txt', 'npm test …'],
    ['npm test --header "X-Auth-Token: hunter2"', 'npm test …'],
    ['npm test --header=Authorization:Bearer hunter2', 'npm test …'],
    ['npm run build -- --env.NPM_TOKEN=hunter2', 'npm run build -- …'],
    ['npm test -H "X-Api-Token: hunter2"', 'npm test …'],
    ['npm test -H "X-Amz-Security-Token: hunter2"', 'npm test …'],
    ['npm test --password=hunter2', 'npm test …'],
    ['npm test --token hunter2', 'npm test …'],
    ['npm test --header X-Custom:hunter2', 'npm test …'],
    ['pytest -k hunter2 tests/test_x.py::test_y', 'pytest tests/test_x.py::test_y …'],
    // HAND-DERIVED: a userinfo URL without a scheme has a single `:` and a `/`, so it passes the path shape; a JWT-shaped word (first segment `eyJ`) has an extension-like tail. Both are dropped; a drive path and a `::` selector keep their colons.
    ['npm test user:hunter2@host/x', 'npm test …'],
    ['npm test eyJhbGciOiJIUzI1NiJ9.hunter2.sig', 'npm test …'],
    ['npx vitest run C:/work/a.test.ts', 'npx vitest run C:/work/a.test.ts'],
    // HAND-DERIVED: from here on, commands with no secret on them, whose stored text says what ran. `--grep parser` loses its flag and value, the one change from the deny-list's output.
    ['npm test', 'npm test'],
    ['npm test --watch --reporter=verbose', 'npm test --watch --reporter=verbose'],
    ['npm run test:unit -- --grep parser', 'npm run test:unit -- …'],
    ['npx vitest run tests/a.test.ts', 'npx vitest run tests/a.test.ts'],
    ['pytest tests/test_x.py::test_y', 'pytest tests/test_x.py::test_y'],
    ['cargo test --features x', 'cargo test …'],
    ['npx tsc --noEmit', 'npx tsc --noEmit'],
    ['npm test --reporter=hunter2', 'npm test …'],
  ]

  const WRITERS: ReadonlyArray<readonly [string, (command: string) => void]> = [
    ['finished run', (command) => noteVerificationRun(command, 1, false)],
    ['failed run', (command) => noteFailedVerificationRun(command, 'Exit code 1', false)],
  ]

  /** Every file under `dir`, so a secret anywhere on disk is found, not only in the session blob. */
  function filesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
  }

  it.each(
    STORED_ROWS.flatMap(([command, expected]) => WRITERS.map(([writer, write]) => [writer, command, expected, write] as const)),
  )('%s: stores %j as %j and never writes hunter2 under a fresh home', (_writer, command, expected, write) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-row-'))
    vi.stubEnv('TOKEN_GOAT_HOME', home)
    clearModuleCaches()
    try {
      const sid = newSession()
      inSession(sid, () => write(command))
      const state = evaluateVerification(sid)
      expect(state.runs[0]?.command).toBe(expected)
      const files = filesUnder(home)
      expect(files.length).toBeGreaterThan(0)
      expect(files.filter((f) => fs.readFileSync(f).includes('hunter2'))).toEqual([])
      expect([receiptLines(state, false).join('\n'), stopAdvisoryText(state) ?? '']).toSatisfy((texts: string[]) => texts.every((t) => !t.includes('hunter2')))
    } finally {
      clearModuleCaches()
      vi.unstubAllEnvs()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // A quoted env value with spaces is not an assignment the prefix matcher can strip, so the segment no longer starts with a check and is dropped: nothing is recorded at all, which is the safe direction.
  it('records nothing for a quoted env value with spaces ahead of the check', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun('PASS="my hunter2 pw" npm test', 1, false))
    expect(evaluateVerification(sid).runs).toHaveLength(0)
  })

  it('keeps every check of a chain, joined, and nothing between them', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun('cd app && npm run lint && FOO=1 npm test', 0, false))
    expect(evaluateVerification(sid).runs[0]?.command).toBe('npm run lint; npm test')
  })

  it('does not mask a flag that only contains the word pass', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun('npx jest --passWithNoTests src/a.test.ts', 0, false))
    expect(evaluateVerification(sid).runs[0]?.command).toBe('npx jest --passWithNoTests src/a.test.ts')
  })

  it('stores the failed-run path the same way', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const sid = newSession()
    inSession(sid, () => noteFailedVerificationRun('X=hunter2 mysqldump -phunter2 db && npm test', 'Exit code 1', false))
    const blob = fs.readFileSync(sessionSidecarPath(sid, '.json') ?? '', 'utf8')
    expect(blob).not.toContain('hunter2')
    expect(evaluateVerification(sid).runs[0]?.command).toBe('npm test')
  })
})

describe('stopHandler', () => {
  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function unverifiedSession(): string {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/widget.ts'))
    return sid
  }

  it('names the edited file when work is unverified', () => {
    const out = stopHandler(stopEvent(unverifiedSession()))
    expect(out.hookType).toBe('context')
    expect(out.hookType === 'context' ? out.context : '').toContain('widget.ts')
  })

  it('says the last check failed, with its command and status', () => {
    const sid = newSession()
    inSession(sid, () => recordVerificationRun('npm test', 1))
    const out = stopHandler(stopEvent(sid))
    expect(out.hookType === 'context' ? out.context : '').toContain('exit 1')
  })

  it('stays silent when everything edited was verified', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 0, Date.now() + 1000)
    })
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
  })

  it('writes nothing for a clean first stop', () => {
    const sid = newSession()
    const advised = sessionSidecarPath(sid, '.stop-advised')
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
    expect(advised !== null && fs.existsSync(advised)).toBe(false)
  })

  it('never answers a stop a hook already continued', () => {
    expect(stopHandler(stopEvent(unverifiedSession(), { stop_hook_active: true })).hookType).toBe('pass')
  })

  it('speaks once per distinct state', () => {
    const sid = unverifiedSession()
    expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
    inSession(sid, () => recordFileEdit('C:/proj/src/other.ts'))
    expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
  })

  // HAND-DERIVED: the order of edits, passing check and stops below is the whole scenario. The first state and the last are identical text ("edited since the last passing check: widget.ts"), so only a forgotten signature lets the last one speak.
  it('speaks again when the same edit-without-check state returns after a passing check', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0)
      const sid = newSession()
      // The same check precedes both edits so the advisory text, and so its signature, is identical each time.
      inSession(sid, () => recordVerificationRun('npm test', 0, T0))
      vi.setSystemTime(T0 + 1000)
      inSession(sid, () => recordFileEdit('C:/proj/src/widget.ts'))
      expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
      expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
      vi.setSystemTime(T0 + 2000)
      inSession(sid, () => recordVerificationRun('npm test', 0, T0 + 2000))
      expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
      vi.setSystemTime(T0 + 3000)
      inSession(sid, () => recordFileEdit('C:/proj/src/widget.ts'))
      expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is off when the config key is off', () => {
    vi.stubEnv('TOKEN_GOAT_STOP_VERIFICATION_ADVISORY', '0')
    clearModuleCaches()
    expect(stopHandler(stopEvent(unverifiedSession())).hookType).toBe('pass')
  })

  it('is quiet during quiet hours', () => {
    vi.stubEnv('TOKEN_GOAT_QUIET_HOURS', '00:00-23:59')
    clearModuleCaches()
    expect(stopHandler(stopEvent(unverifiedSession())).hookType).toBe('pass')
  })

  it('does nothing on Copilot CLI, whose agentStop drops a non-blocking message', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    expect(stopHandler(stopEvent(unverifiedSession())).hookType).toBe('pass')
  })

  // FORMAT-DERIVED: extension.js (<user>/AppData/Local/Programs/Microsoft VS Code/07f806f999/resources/app/extensions/copilot/dist/extension.js, VS Code 1.140.0 with Copilot Chat 0.68.0, sha256 a918eb6ed04a7fb10ab673f2243b4dbd9ac8368c8ba82a60194d74ca45c1191f) executeStopHook reads only hookSpecificOutput.decision === 'block' and reason; src/bridges/vscode_hooks.ts answers a stop context with {}.
  it.each(['copilot_cli', 'vscode'])('does nothing on %s and does not mark the advisory as given', (harness) => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', harness)
    const sid = unverifiedSession()
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
    const advised = sessionSidecarPath(sid, '.stop-advised')
    expect(advised !== null && fs.existsSync(advised)).toBe(false)
  })

  it('judges a subagent on its own commands', () => {
    const sid = unverifiedSession()
    const agentKey = `${sid}:agent:sub1`
    inSession(agentKey, () => recordVerificationRun('npm test', 0))
    expect(stopHandler(stopEvent(sid, {}, 'sub1')).hookType).toBe('pass')
    expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
  })

  it('quotes a file name that carries a backtick instead of opening a code span', () => {
    const text = stopAdvisoryText({ runs: [], failingUnresolved: false, editedFiles: ['a`b.ts'], editedAnyFile: true, editedSinceLastPass: ['a`b.ts'] })
    expect(text).not.toContain('`')
  })
})

describe('the built hook entry, per host', () => {
  const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')
  let root: string
  let project: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-e2e-'))
    project = path.join(root, 'proj')
    for (const d of ['proj', 'tg', 'local', 'xdg', 'home', 'claude', 'codex']) fs.mkdirSync(path.join(root, d), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function hook(event: string, harness: string, payload: Record<string, unknown>): { status: number; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', event], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      input: JSON.stringify({ cwd: project.replaceAll(path.sep, '/'), ...payload }),
      env: {
        ...process.env,
        TOKEN_GOAT_HOME: path.join(root, 'tg'),
        LOCALAPPDATA: path.join(root, 'local'),
        XDG_DATA_HOME: path.join(root, 'xdg'),
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CODEX_HOME: path.join(root, 'codex'),
        TOKEN_GOAT_HARNESS_OVERRIDE: harness,
        TOKEN_GOAT_HOOK_SERVER: '0',
        TOKEN_GOAT_NATIVE_HOOKS: '0',
        TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      },
    })
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: `${res.error?.message ?? ''}${res.stderr ?? ''}` }
  }

  /** A hook call that sets a row up: the process has to have run and answered, because a call that did not leaves the state the stop reads without its step and the row then fails on the wrong thing, the stop's text. Every answer a hook gives is a JSON object, so an empty stdout or a non-zero status means it never got that far. */
  function setUpHook(event: string, harness: string, payload: Record<string, unknown>): void {
    const res = hook(event, harness, payload)
    expect(res.status, `${event} hook did not run: ${res.stderr}`).toBe(0)
    expect(() => JSON.parse(res.stdout), `${event} hook printed no JSON object: ${JSON.stringify(res.stdout)} ${res.stderr}`).not.toThrow()
  }

  /** The verification runs the session blob holds on disk, read the way the stop reads them: from the file, never from what a hook process printed. */
  function storedRunCommands(): string[] {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.json') && full.includes(`${path.sep}sessions${path.sep}`)) {
          const blob = JSON.parse(fs.readFileSync(full, 'utf8')) as { verificationRuns?: Array<{ command: string }> }
          for (const run of blob.verificationRuns ?? []) found.push(run.command)
        }
      }
    }
    walk(path.join(root, 'tg'))
    return found
  }

  it('codex: a test run that reported no status, then an edit, then a stop names the file and the run', () => {
    // FORMAT-DERIVED: a Codex PostToolUse carries tool_response as a plain string (https://developers.openai.com/codex/hooks), with no exit status field.
    const file = `${project.replaceAll(path.sep, '/')}/src/widget.ts`
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'widget.ts'), 'export const w = 1\n')
    const base = { session_id: 'e2e-stop-codex', permission_mode: 'default', turn_id: 'turn-1', transcript_path: null }
    setUpHook('post_tool_use', 'codex', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' }, tool_response: 'ok' })
    // The step the stop's text is about, checked where it lands: a run the hook did not store is named here, not by a missing word in the stop's message.
    expect(storedRunCommands()).toEqual(['npm test'])
    setUpHook('post_tool_use', 'codex', { ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'call_2', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-export const w = 1\n+export const w = 2\n*** End Patch` }, tool_response: 'Success' })
    const out = hook('stop', 'codex', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' })
    expect(out.status).toBe(0)
    const message = (JSON.parse(out.stdout) as { systemMessage?: string }).systemMessage ?? ''
    expect(message).toContain('widget.ts')
    expect(message).toContain('npm test')
  })

  it('claudecode: an edit, a failed test run, then a stop yields a systemMessage naming both', () => {
    const harness = 'claudecode'
    const stopName = 'Stop'
    const sid = `e2e-stop-${harness}`
    const file = `${project.replaceAll(path.sep, '/')}/src/widget.ts`
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'widget.ts'), 'export const w = 1\n')
    const base = { session_id: sid, permission_mode: 'default' }
    setUpHook('post_tool_use', harness, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'export const w = 1\n' }, tool_response: { filePath: file, success: true } })
    setUpHook('post_tool_use_failure', harness, { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', error: 'Exit code 1\nFAIL', is_interrupt: false })
    const out = hook('stop', harness, { ...base, hook_event_name: stopName, stop_hook_active: false, last_assistant_message: 'Done.' })
    expect(out.status).toBe(0)
    const message = (JSON.parse(out.stdout) as { systemMessage?: string }).systemMessage ?? ''
    expect(message).toContain('widget.ts')
    expect(message).toContain('exit 1')
  })
})

describe('the command the advisory names', () => {
  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // HAND-DERIVED: U+202E reorders the text after it, U+0007 is a terminal bell, and a backtick opens a code span in the model's context. Each leads a path-like word, the one place the stored check once let any first character through.
  it.each(['\u202e', '`', '\u0007'])('does not store a path word that starts with %j, and the advisory never carries it', (lead) => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/widget.ts')
      noteVerificationRun(`pytest ${lead}tests/a.test.ts`, 1, false)
    })
    const state = evaluateVerification(sid)
    expect(state.runs[0]?.command).toBe('pytest …')
    expect(stopAdvisoryText(state)).not.toContain(lead)
  })

  // HAND-DERIVED: the stored command reaches the model through stopAdvisoryText, so a bidi or control character that did get into a stored run is escaped there rather than written raw.
  it.each(['\u202e', '\u0007'])('escapes %j in a stored command before it reaches the model', (lead) => {
    const state = { runs: [], latestRun: { command: `pytest ${lead}a.py`, exitCode: 1, at: T0 }, failingUnresolved: true, editedFiles: [], editedAnyFile: false, editedSinceLastPass: [] }
    const text = stopAdvisoryText(state) ?? ''
    expect(text).toContain('pytest')
    expect(text).not.toContain(lead)
  })

  // HAND-DERIVED: each is a code point that prints as a blank or nothing and is not a Unicode format character (NBSP, VS16, the Hangul fillers, the combining grapheme joiner, the Khmer inherent vowels, the braille blank) plus a lone high and a lone low surrogate.
  it.each([0x00a0, 0xfe0f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x034f, 0x17b4, 0x17b5, 0x2800, 0xd800, 0xdc00])('escapes the blank-looking code unit %i in a stored command', (unit) => {
    const blank = String.fromCharCode(unit)
    const state = { runs: [], latestRun: { command: `pytest${blank}a.py`, exitCode: 1, at: T0 }, failingUnresolved: true, editedFiles: [], editedAnyFile: false, editedSinceLastPass: [] }
    const text = stopAdvisoryText(state) ?? ''
    expect(text).toContain('pytest')
    expect(text).not.toContain(blank)
    expect(text).toContain(String.fromCharCode(92) + 'u' + unit.toString(16).padStart(4, '0'))
  })

  it('still keeps an ordinary path and a home-relative or scoped one', () => {
    const sid = newSession()
    inSession(sid, () => noteVerificationRun('pytest tests/a.test.ts ~/x/b.py @scope/pkg/c.ts', 0, false))
    expect(evaluateVerification(sid).runs[0]?.command).toBe('pytest tests/a.test.ts ~/x/b.py @scope/pkg/c.ts')
  })
})
