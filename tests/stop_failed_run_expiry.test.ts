// HAND-DERIVED commands; failure text and agent key FORMAT-DERIVED from hooks_verification, hook_registry.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stopHandler } from '../src/hooks_stop.js'
import { sessionStateKey } from '../src/hook_registry.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import {
  evaluateVerification,
  isVerificationCommand,
  noteFailedVerificationRun,
  noteVerificationRun,
  verificationScopeFor,
} from '../src/verification_state.js'
import { makeHookEvent } from './helpers/hook-event.js'

const newSession = (): string => `s-expiry-${process.pid}-${Math.random().toString(36).slice(2)}`

function inSession(key: string, work: () => void): void {
  loadSessionState(key)
  try {
    work()
  } finally {
    saveSessionState(key)
  }
}

function stopEvent(sessionId: string, cwd: string | undefined, agentId?: string) {
  const raw = { hook_event_name: 'Stop', stop_hook_active: false, ...(cwd === undefined ? {} : { cwd }) }
  return makeHookEvent({ eventName: 'stop', toolName: undefined, sessionId, agentId, raw })
}

type Out = ReturnType<typeof stopHandler>
const contextOf = (out: Out): string => (out.hookType === 'context' ? out.context : '')

const SETTINGS = ['user.name=t', 'user.email=t@example.invalid', 'commit.gpgsign=false', 'gc.auto=0']
const GIT_FLAGS = [...SETTINGS, 'maintenance.auto=false', 'core.hooksPath='].flatMap((s) => ['-c', s])

function git(dir: string, ...args: string[]): void {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[name]
  const res = spawnSync('git', [...GIT_FLAGS, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
  expect(res.status, `git ${args.join(' ')}: ${res.stderr}`).toBe(0)
}

function makeRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'one')
  return repo
}

function isolateGitEnv(): void {
  clearModuleCaches()
  vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  for (const name of ['GIT_DIR', 'GIT_CEILING_DIRECTORIES']) vi.stubEnv(name, undefined)
}

const VITEST_A = 'npx vitest run tests/a.test.ts'

describe('a failed check expires when HEAD moves', () => {
  let repo: string
  let outside: string

  beforeEach(() => {
    isolateGitEnv()
    repo = makeRepo('tg-expiry-repo-')
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-expiry-none-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const failedCheck = (key: string, cwd: string = repo): void => {
    inSession(key, () => noteFailedVerificationRun(VITEST_A, 'Exit code 2\nFAIL', false, cwd))
  }

  it('(a) reports the failed run while HEAD is unchanged', () => {
    const sid = newSession()
    failedCheck(sid)
    expect(contextOf(stopHandler(stopEvent(sid, repo)))).toContain('the last check failed')
  })

  it('(b) does not report the failed run once a commit moved HEAD', () => {
    const sid = newSession()
    failedCheck(sid)
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'two')
    expect(evaluateVerification(sid, verificationScopeFor(repo)).failingUnresolved).toBe(false)
    expect(contextOf(stopHandler(stopEvent(sid, repo)))).toBe('')
  })

  it('(c) does not report a record with no stored HEAD, nor when HEAD cannot be read now', () => {
    const old = newSession()
    inSession(old, () => recordVerificationRun('npm test', 1))
    expect(contextOf(stopHandler(stopEvent(old, repo)))).toBe('')
    const unreadable = newSession()
    failedCheck(unreadable)
    expect(contextOf(stopHandler(stopEvent(unreadable, outside)))).toBe('')
    expect(contextOf(stopHandler(stopEvent(unreadable, undefined)))).toBe('')
  })

  it('stores no HEAD for a call made outside a repository, so a later stop stays silent', () => {
    const sid = newSession()
    failedCheck(sid, outside)
    expect(contextOf(stopHandler(stopEvent(sid, repo)))).toBe('')
  })

  it("(h) a subagent's failed run is not the parent's unverified work", () => {
    // Hook events inside a subagent carry agent_id and the state key is salted with it.
    const sid = newSession()
    const agentEvent = stopEvent(sid, repo, 'agent-1')
    expect(sessionStateKey(agentEvent)).not.toBe(sessionStateKey(stopEvent(sid, repo)))
    failedCheck(sessionStateKey(agentEvent))
    expect(contextOf(stopHandler(stopEvent(sid, repo)))).toBe('')
    expect(contextOf(stopHandler(agentEvent))).toContain('the last check failed')
  })
})

describe('the failure path judges a command as the pass path does', () => {
  let repo: string

  beforeEach(() => {
    isolateGitEnv()
    repo = makeRepo('tg-expiry-sym-')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  const recordedAfterFailure = (command: string): string[] => {
    const sid = newSession()
    inSession(sid, () => noteFailedVerificationRun(command, 'Exit code 1', false, repo))
    return evaluateVerification(sid).runs.map((r) => r.command)
  }
  const recordedAfterPass = (command: string): string[] => {
    const sid = newSession()
    inSession(sid, () => noteVerificationRun(command, 0, false, repo))
    return evaluateVerification(sid).runs.map((r) => r.command)
  }

  it('(d) a piped check is recorded by neither path without pipefail, and by both with it', () => {
    expect(recordedAfterPass('npm test | tail -5')).toEqual([])
    expect(recordedAfterFailure('npm test | tail -5')).toEqual([])
    expect(recordedAfterPass('set -o pipefail; npm test | tail -5')).toEqual(['npm test'])
    expect(recordedAfterFailure('set -o pipefail; npm test | tail -5')).toEqual(['npm test'])
  })

  it('(e) a check word inside an inline -c or -e body is not a check, however the body exits', () => {
    const bodies = ['python3 -c "print(1); pytest -x; raise SystemExit(2)"']
    bodies.push("node -e 'console.log(1); npm test; process.exit(2)'")
    for (const command of bodies) {
      expect(isVerificationCommand(command), command).toBe(false)
      expect(recordedAfterFailure(command), command).toEqual([])
      expect(recordedAfterPass(command), command).toEqual([])
    }
    expect(recordedAfterFailure('node -e "console.log(1)" && npm test')).toEqual([])
    expect(recordedAfterPass('node -e "console.log(1)" && npm test')).toEqual(['npm test'])
  })

  it('(f) a launcher carrying a check counts as that check', () => {
    const launched = `python tools/launch.py ${VITEST_A}`
    expect(isVerificationCommand(launched)).toBe(true)
    const sid = newSession()
    inSession(sid, () => noteFailedVerificationRun(VITEST_A, 'Exit code 1', false, repo))
    expect(evaluateVerification(sid, verificationScopeFor(repo)).failingUnresolved).toBe(true)
    inSession(sid, () => noteVerificationRun(launched, 0, false, repo))
    const after = evaluateVerification(sid, verificationScopeFor(repo))
    expect(after.failingUnresolved).toBe(false)
    expect(after.runs.map((r) => r.command)).toEqual([VITEST_A])
  })

  it('(f) a launcher line that only mentions a check, or detaches it, is not a check', () => {
    const lines = ['python tools/notes.py log "run npm test now"']
    lines.push("python tools/notes.py echo 'npx vitest run'")
    lines.push('python tools/notes.py log $(npm test)', `python tools/launch.py start ${VITEST_A}`)
    for (const line of lines) {
      expect(isVerificationCommand(line), line).toBe(false)
      expect(recordedAfterPass(line), line).toEqual([])
    }
  })

  it('(g) a background start records nothing and clears nothing; no event reports its completion', () => {
    // FORMAT-DERIVED: fixtures/harness_hook_payloads.ts lists the events hosts send; none is a completion.
    const sid = newSession()
    inSession(sid, () => noteFailedVerificationRun('npm test', 'Exit code 1', false, repo))
    inSession(sid, () => noteVerificationRun('npm test', 0, true, repo))
    const state = evaluateVerification(sid, verificationScopeFor(repo))
    expect(state.failingUnresolved).toBe(true)
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]?.exitCode).toBe(1)
  })
})
