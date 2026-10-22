// The Stop advisory's scope: which edits it is about, and which finished commands count as a check. Every expected verdict is HAND-DERIVED from the order of the edits and runs each row performs; the scope rows run real directories, one of them outside the OS temp dir.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { postBashHandler } from '../src/hooks_bash_post.js'
import { stopHandler } from '../src/hooks_stop.js'
import { mayBeVerificationCommand } from '../src/hooks_verification.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { evaluateVerification, isVerificationCommand, noteFailedVerificationRun, noteVerificationRun, verificationScopeFor } from '../src/verification_state.js'
import { makeHookEvent } from './helpers/hook-event.js'

const newSession = (): string => `s-scope-${process.pid}-${Math.random().toString(36).slice(2)}`

function inSession(key: string, work: () => void): void {
  loadSessionState(key)
  try {
    work()
  } finally {
    saveSessionState(key)
  }
}

const stopEvent = (sessionId: string, cwd?: string) =>
  makeHookEvent({ eventName: 'stop', toolName: undefined, sessionId, raw: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.', ...(cwd !== undefined ? { cwd } : {}) } })

const fwd = (p: string): string => p.replaceAll(path.sep, '/')

describe('edits the advisory is about', () => {
  let base: string

  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('an edit under the OS temp dir needs no check when no project root is known', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit(fwd(path.join(base, 'probe_new.py'))))
    expect(evaluateVerification(sid, verificationScopeFor(undefined)).editedSinceLastPass).toEqual([])
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
  })

  it('an edit outside the session project root needs no check, whatever its language', () => {
    const sid = newSession()
    const project = path.join(base, 'proj')
    const elsewhere = path.join(base, 'other')
    fs.mkdirSync(project, { recursive: true })
    inSession(sid, () => recordFileEdit(fwd(path.join(elsewhere, 'ceil_total.py'))))
    expect(evaluateVerification(sid, { projectRoot: project }).editedSinceLastPass).toEqual([])
    expect(stopHandler(stopEvent(sid, fwd(project))).hookType).toBe('pass')
  })

  it('a source edit inside the project root still gets the advisory, even when the project lives under the temp dir', () => {
    const sid = newSession()
    const project = path.join(base, 'proj')
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    inSession(sid, () => recordFileEdit(fwd(path.join(project, 'src', 'widget.ts'))))
    expect(evaluateVerification(sid, verificationScopeFor(fwd(project))).editedSinceLastPass).toEqual(['widget.ts'])
    const out = stopHandler(stopEvent(sid, fwd(project)))
    expect(out.hookType).toBe('context')
  })

  it('the root is the nearest project marker above the working directory', () => {
    const project = path.join(base, 'proj')
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(project, '.git'), { recursive: true })
    const sid = newSession()
    inSession(sid, () => recordFileEdit(fwd(path.join(project, 'lib', 'a.ts'))))
    // The session works in a subdirectory, but its edit beside it is still inside the project the marker names.
    expect(evaluateVerification(sid, verificationScopeFor(fwd(path.join(project, 'sub')))).editedSinceLastPass).toEqual(['a.ts'])
  })

  it('a mixed session names only the edit inside the root', () => {
    const sid = newSession()
    const project = path.join(base, 'proj')
    fs.mkdirSync(project, { recursive: true })
    inSession(sid, () => {
      recordFileEdit(fwd(path.join(base, 'scratch', 'probe.py')))
      recordFileEdit(fwd(path.join(project, 'real.ts')))
    })
    expect(evaluateVerification(sid, { projectRoot: project }).editedSinceLastPass).toEqual(['real.ts'])
  })
})

describe('edits outside the project root', () => {
  let base: string

  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    // Under the working directory, not the OS temp dir (the suite's HOME and temp dir share a root), so the temp-dir dismissal cannot be what decides a row.
    base = fs.mkdtempSync(path.join(process.cwd(), 'tg-scope-nontemp-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('an edit in a sibling package still gets the advisory when the session works in another package', () => {
    const sid = newSession()
    const a = path.join(base, 'packages', 'a')
    const b = path.join(base, 'packages', 'b')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    fs.writeFileSync(path.join(a, 'package.json'), '{}')
    inSession(sid, () => recordFileEdit(fwd(path.join(b, 'util.ts'))))
    expect(evaluateVerification(sid, verificationScopeFor(fwd(a))).editedSinceLastPass).toEqual(['util.ts'])
    expect(stopHandler(stopEvent(sid, fwd(a))).hookType).toBe('context')
  })

  it('an edit in another repo or a sibling worktree still gets the advisory', () => {
    const sid = newSession()
    const project = path.join(base, 'proj')
    fs.mkdirSync(project, { recursive: true })
    inSession(sid, () => {
      recordFileEdit(fwd(path.join(base, 'proj-wt', 'a.ts')))
      recordFileEdit(fwd(path.join(base, 'other-repo', 'b.py')))
    })
    expect(evaluateVerification(sid, { projectRoot: project }).editedSinceLastPass).toEqual(['a.ts', 'b.py'])
  })

  it('a scratchpad edit under the OS temp dir needs no check', () => {
    const sid = newSession()
    const project = path.join(base, 'proj')
    fs.mkdirSync(project, { recursive: true })
    const scratch = path.join(os.tmpdir(), 'claude', 'scratchpad-scope', 'probe.py')
    inSession(sid, () => recordFileEdit(fwd(scratch)))
    expect(evaluateVerification(sid, { projectRoot: project }).editedSinceLastPass).toEqual([])
    expect(stopHandler(stopEvent(sid, fwd(project))).hookType).toBe('pass')
  })

  it('a spelling of the root with other case or backslashes is still inside it, even for a project under the temp dir', () => {
    const sid = newSession()
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-case-'))
    try {
      const root = tempProject
      const variant = process.platform === 'win32' ? root.toUpperCase() : root
      inSession(sid, () => recordFileEdit(path.join(variant, 'src', 'w.ts')))
      expect(evaluateVerification(sid, { projectRoot: fwd(root) }).editedSinceLastPass).toEqual(['w.ts'])
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true })
    }
  })
})

describe('script checks', () => {
  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    'python scripts/validate-skills.py',
    'python scripts/run_self_tests.py',
    'python3 tools/run_tests.py tests/test_parser.py::test_x',
    'python scripts/validate-skills.py skills/foo/SKILL.md --self-test',
    'python scripts/check_related_skills.py',
    'python scripts/anything.py --self-test',
    'cd repo && python scripts/validate_x.py',
  ])('counts %j', (command) => {
    expect(isVerificationCommand(command)).toBe(true)
    expect(mayBeVerificationCommand(command)).toBe(true)
  })

  it.each([
    'python foo.py',
    'python scripts/build_site.py',
    'python scripts/checker.py',
    'python -c "print(1)"',
    'python scripts/validate-skills.py.bak',
    'python scripts/run_tests.sh',
    'ls scripts/validate-skills.py',
    'cat scripts/check_x.py',
    'python scripts/validate-skills.py --help',
    'python scripts/validate-skills.py -h',
    'python scripts/run_self_tests.py --list',
    'python scripts/check_x.py --version',
    'python scripts/check_x.py --dry-run',
    'python scripts/check_x.py --frobnicate',
    'python scripts/check_x.py --self-test --help',
    'python scripts/anything.py --self-test --list',
    'python scripts/check_x.py help',
    'python3 tools/run_tests.py -k parser',
  ])('does not count %j', (command) => {
    expect(isVerificationCommand(command)).toBe(false)
  })

  it('a help run records nothing and leaves the edit unverified', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/a.ts'))
    inSession(sid, () => noteVerificationRun('python scripts/validate-skills.py --help', 0, false))
    const state = evaluateVerification(sid)
    expect(state.runs).toEqual([])
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
  })

  function runsAfter(work: () => void): readonly { command: string; exitCode: number | null }[] {
    const sid = newSession()
    inSession(sid, work)
    return evaluateVerification(sid).runs
  }

  it('records a passing script check and clears the edit before it', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/a.ts'))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 5000)
      inSession(sid, () => noteVerificationRun('python scripts/run_self_tests.py', 0, false))
    } finally {
      vi.useRealTimers()
    }
    const state = evaluateVerification(sid)
    expect(state.runs.map((r) => [r.command, r.exitCode])).toEqual([['python scripts/run_self_tests.py', 0]])
    expect(state.editedSinceLastPass).toEqual([])
  })

  it('a failing script check is reported as a failure', () => {
    const runs = runsAfter(() => noteFailedVerificationRun('python scripts/validate-skills.py', 'Exit code 1\nbad frontmatter', false))
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([['python scripts/validate-skills.py', 1]])
  })

  it('stores only the script path and the self-test switch, never another argument', () => {
    const runs = runsAfter(() => noteVerificationRun('python scripts/validate-skills.py skills/a.md user:hunter2@host/x', 0, false))
    expect(runs.map((r) => r.command)).toEqual([])
    const kept = runsAfter(() => noteVerificationRun('python scripts/validate-skills.py skills/a.md', 0, false))
    expect(kept.map((r) => r.command)).toEqual(['python scripts/validate-skills.py skills/a.md'])
    const selfTest = runsAfter(() => noteVerificationRun('python scripts/x.py --self-test', 0, false))
    expect(selfTest.map((r) => r.command)).toEqual(['python scripts/x.py --self-test'])
  })

  it('an unrecognised script run records nothing', () => {
    expect(runsAfter(() => noteVerificationRun('python foo.py', 0, false))).toEqual([])
  })
})

describe('git commit and push are never a check', () => {
  let repo: string

  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nogit-'))
    const init = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8', windowsHide: true })
    expect(init.status, init.stderr).toBe(0)
    spawnSync('git', ['config', 'gc.auto', '0'], { cwd: repo, windowsHide: true })
    spawnSync('git', ['config', 'maintenance.auto', 'false'], { cwd: repo, windowsHide: true })
    for (const hook of ['pre-push', 'pre-commit']) {
      fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it.each(['git push', 'git push origin main', 'git commit -m done', 'git push --no-verify'])('%j leaves the edit unverified even beside a runnable hook on a clean tree', async (command) => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/a.ts'))
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', sessionId: sid, toolInput: { command }, raw: { cwd: fwd(repo), tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'To origin\n   abc..def  main -> main', stderr: '' } } })
    loadSessionState(sid)
    try {
      await postBashHandler(event)
    } finally {
      saveSessionState(sid)
    }
    const state = evaluateVerification(sid)
    expect(state.runs).toEqual([])
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
  })
})
