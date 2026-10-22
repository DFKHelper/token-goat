// The Stop advisory's scope: which edits it is about, and which finished commands count as a check. Every expected verdict is HAND-DERIVED from the order of the edits and runs each row performs; the git rows run a real repository and a real hook file.

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
    'python3 tools/run_tests.py -k parser',
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
  ])('does not count %j', (command) => {
    expect(isVerificationCommand(command)).toBe(false)
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
    const runs = runsAfter(() => noteVerificationRun('python scripts/validate-skills.py --token hunter2 sk-secretvalue', 0, false))
    expect(runs.map((r) => r.command)).toEqual(['python scripts/validate-skills.py …'])
    const selfTest = runsAfter(() => noteVerificationRun('python scripts/x.py --self-test', 0, false))
    expect(selfTest.map((r) => r.command)).toEqual(['python scripts/x.py --self-test'])
  })

  it('an unrecognised script run records nothing', () => {
    expect(runsAfter(() => noteVerificationRun('python foo.py', 0, false))).toEqual([])
  })
})

describe('hook-backed git commands', () => {
  let repo: string

  const git = (...args: string[]): void => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
    expect(res.status, `git ${args.join(' ')}: ${res.stderr}`).toBe(0)
  }

  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hookgit-'))
    git('init', '-q')
    git('config', 'gc.auto', '0')
    git('config', 'maintenance.auto', 'false')
    git('config', 'user.email', 'scope@example.invalid')
    git('config', 'user.name', 'scope')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init', '--no-verify')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  const installHook = (name: string, dir = path.join(repo, '.git', 'hooks')): void => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  function recorded(command: string, exitCode: number | null, output = 'To origin\n   abc..def  main -> main', cwd: string | null = repo): string[] {
    const sid = newSession()
    inSession(sid, () => noteVerificationRun(command, exitCode, false, { cwd, output }))
    return evaluateVerification(sid).runs.map((r) => `${r.command}:${r.exitCode}`)
  }

  it('a passing push counts when a pre-push hook exists and the tree is clean', () => {
    installHook('pre-push')
    expect(recorded('git push origin main', 0)).toEqual(['git push:0'])
  })

  it('a passing commit counts through a pre-commit hook found by core.hooksPath', () => {
    installHook('pre-commit', path.join(repo, '.husky'))
    git('config', 'core.hooksPath', '.husky')
    git('add', '.husky')
    git('commit', '-q', '-m', 'hooks', '--no-verify')
    expect(recorded('git commit -m "done"', 0)).toEqual(['git commit:0'])
  })

  it('does not count without the hook the command would run', () => {
    expect(recorded('git push', 0)).toEqual([])
    installHook('pre-commit')
    expect(recorded('git push', 0)).toEqual([])
  })

  it('does not count a push with a hook that was a no-op', () => {
    installHook('pre-push')
    expect(recorded('git push', 0, 'Everything up-to-date')).toEqual([])
  })

  it('does not count while uncommitted or untracked work sits outside the checked commit', () => {
    installHook('pre-push')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    expect(recorded('git push', 0)).toEqual([])
    git('checkout', '--', 'a.txt')
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export {}\n')
    expect(recorded('git push', 0)).toEqual([])
  })

  it.each(['git push --no-verify', 'git commit -n -m x', 'git push -n', 'git push --dry-run', 'git push --no-ver', 'HUSKY=0 git commit -m x', 'git push || true', 'git push | tail -1', 'git -c core.hooksPath=/dev/null push', 'git status'])('does not count %j', (command) => {
    installHook('pre-push')
    installHook('pre-commit')
    expect(recorded(command, 0)).toEqual([])
  })

  it('never records a failed or unknown-status push, and needs a working directory', () => {
    installHook('pre-push')
    expect(recorded('git push', 1)).toEqual([])
    expect(recorded('git push', null)).toEqual(['git push:0'])
    expect(recorded('git push', 0, 'To origin', null)).toEqual([])
  })

  it('a background launch is not a verdict', () => {
    installHook('pre-push')
    const sid = newSession()
    inSession(sid, () => noteVerificationRun('git push', 0, true, { cwd: repo, output: 'To origin' }))
    expect(evaluateVerification(sid).runs).toEqual([])
  })

  it('the post-Bash hook hands the command its directory and output', async () => {
    installHook('pre-push')
    const sid = newSession()
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', sessionId: sid, toolInput: { command: 'git push' }, raw: { cwd: fwd(repo), tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: { stdout: 'To origin\n   abc..def  main -> main', stderr: '' } } })
    loadSessionState(sid)
    try {
      await postBashHandler(event)
    } finally {
      saveSessionState(sid)
    }
    expect(evaluateVerification(sid).runs.map((r) => r.command)).toEqual(['git push'])
  })
})
