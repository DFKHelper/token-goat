// When `git status` does not finish, the subagent receipt says so instead of reading as a clean result. Provenance: the SubagentStop payload keys (session_id, cwd, agent_id, agent_type, stop_hook_active, last_assistant_message) are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (SubagentStop), the same source tests/agent_receipt.test.ts cites; the Agent tool result is a plain string there too. Every git status answer is canned at the runGitAsyncLazy seam, so no row waits on a real git finishing inside any bound: the bound each call asked for is recorded, then the canned answer is returned. A git that did not finish is the killed answer `{ exitCode: -1, timedOut: true }` (HAND-DERIVED: src/types.ts::GitResult). The other answers are CAPTURE, Git for Windows 2.53.0 here: `git status --porcelain` printed nothing and exited 0 in a fresh `git init` directory, printed `?? new.txt` and a newline once new.txt existed there, and printed `fatal: not a git repository (or any of the parent directories): .git` on stderr and exited 128 in a directory with no repository above it. Two rows keep the real runner and say why where they stand.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { runHook as RunHookFn } from '../src/hook_registry.js'
import type * as UtilModule from '../src/util.js'
import type { GitResult, RunGitAsyncOptions } from '../src/types.js'
import type { subagentStopHandler as SubagentStopHandlerFn } from '../src/agent_receipt.js'
import type { buildEvent as BuildEventFn } from '../src/relay.js'

import { KILLED_GIT, NOT_A_REPOSITORY } from './helpers/canned_git.js'
import { GIT_STATUS_TIMEOUT_MS, receiptLines } from '../src/agent_receipt.js'
import type { VerificationState } from '../src/verification_state.js'

const bound = vi.hoisted(() => ({ statusCalls: 0, timeouts: [] as unknown[], passThrough: false, answer: undefined as GitResult | Promise<GitResult> | undefined, onStatus: undefined as (() => void) | undefined, unanswered: [] as string[] }))

// Every git status the receipt or the stop warning asks for is counted, sync or async. The bound each async status call asked for is recorded before it is answered, `answer` stands in for the result (a promise holds the call open until the test settles it), `onStatus` tells the test a status call has arrived, and `passThrough` sends a call to the real runner untouched. A call nothing answered is recorded in `unanswered`, which afterEach requires to be empty.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => {
      if (args.includes('status')) {
        bound.statusCalls += 1
        bound.timeouts.push(opts?.timeoutMs)
      }
      return actual.runGit(args, opts)
    },
    runGitAsyncLazy: async (args: string[], opts: RunGitAsyncOptions = {}) => {
      if (args.includes('status')) {
        bound.statusCalls += 1
        bound.timeouts.push(opts.timeoutMs)
        bound.onStatus?.()
      }
      if (bound.answer !== undefined) return bound.answer
      if (bound.passThrough) return actual.runGitAsyncLazy(args, opts)
      bound.unanswered.push(args.join(' '))
      return { stdout: '', stderr: 'no canned answer for this call', exitCode: 1, unfinished: false }
    },
  }
})

let runHook: typeof RunHookFn
let buildEvent: typeof BuildEventFn
let subagentStopHandler: typeof SubagentStopHandlerFn

const CLAIM = 'I fixed the parser bug.'
const NOTE = "git status did not finish, so this report's change claim was not checked."

// CAPTURE: `git status --porcelain` in a fresh `git init` directory printed nothing and exited 0.
const CLEAN_TREE: GitResult = { stdout: '', stderr: '', unfinished: false, exitCode: 0 }
// CAPTURE: the same command printed `?? new.txt` and a newline once an untracked new.txt existed.
const UNTRACKED_FILE: GitResult = { stdout: '?? new.txt\n', stderr: '', unfinished: false, exitCode: 0 }

let repo = ''

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A status call the test holds open until it hands `release` the answer, so the call is pending for as long as the test needs. `entered` resolves once the status call has arrived at the seam. */
function heldGit(): { entered: Promise<void>; release: (answer: GitResult) => void } {
  let release!: (answer: GitResult) => void
  bound.answer = new Promise<GitResult>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    bound.onStatus = resolve
  })
  return { entered, release }
}

beforeEach(async () => {
  vi.resetModules()
  runHook = (await import('../src/hook_registry.js')).runHook
  buildEvent = (await import('../src/relay.js')).buildEvent
  subagentStopHandler = (await import('../src/agent_receipt.js')).subagentStopHandler
  bound.statusCalls = 0
  bound.timeouts = []
  bound.passThrough = false
  bound.answer = undefined
  bound.onStatus = undefined
  bound.unanswered = []
})

afterEach(() => {
  try {
    expect(bound.unanswered, 'a git call that reached the seam with no canned answer').toEqual([])
  } finally {
    bound.answer = undefined
    bound.onStatus = undefined
    bound.passThrough = false
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (repo !== '') fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    repo = ''
  }
})

let sessionCounter = 0
const stopPayload = (sid: string, cwd: string, message: string) => ({
  session_id: sid,
  cwd: cwd.replaceAll(path.sep, '/'),
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id: 'sub1',
  agent_type: 'general-purpose',
  last_assistant_message: message,
})
const newSession = (): string => `s-unfinished-${process.pid}-${sessionCounter++}-${Math.random().toString(36).slice(2)}`
// The event names the directory the roster is read from, so a developer's own .claude/agents under the process cwd never reaches these expectations.
const agentResult = (sid: string, text: string) => runHook(buildEvent('post_tool_use', { tool_name: 'Agent', tool_input: { prompt: 'Look into it.' }, session_id: sid, tool_response: text, cwd: repo.replaceAll(path.sep, '/') }))

const state = (overrides: Partial<VerificationState> = {}): VerificationState => ({ runs: [], failingUnresolved: false, editedFiles: [], editedAnyFile: false, editedSinceLastPass: [], ...overrides })

describe('a change claim whose git status did not finish', () => {
  it('gets one plain line through the real registry, not a clean result', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-unfinished-'))
    bound.answer = KILLED_GIT
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain(NOTE)
    expect(delivered).not.toContain('recorded no edit')
  })

  it('is not said for a report that claims nothing, which needs no git at all', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-unfinished-'))
    bound.answer = KILLED_GIT
    const message = 'The handler adds a header to each request.'
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, message)))
    expect((await agentResult(sid, message)).hookType).toBe('pass')
    expect(bound.statusCalls).toBe(0)
  })

  it('is not said when git finishes: a clean tree still gets the clean-tree flag', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-unfinished-'))
    bound.answer = CLEAN_TREE
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain('recorded no edit')
    expect(delivered).not.toContain(NOTE)
  })

  it('is not said for a git that fails for another reason: a directory that is not a repository', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-norepo-'))
    bound.answer = NOT_A_REPOSITORY
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })

  // The real runner, kept on purpose: with PATH empty the spawn is refused at once, so no slow git can change the outcome, and the answer it gives for a missing git is the subject.
  it('is not said when git is missing from PATH', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-nogit-'))
    git(repo, 'init', '-q')
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-emptypath-'))
    bound.passThrough = true
    vi.stubEnv('PATH', empty)
    try {
      await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(empty, { recursive: true, force: true })
    }
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })

  it('sits beside the other lines instead of replacing them', () => {
    const failed = { command: 'npm test', exitCode: 1, at: 0 }
    const lines = receiptLines(state({ failingUnresolved: true, latestRun: failed, runs: [failed] }), false, true)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(`token-goat: ${NOTE}`)
    expect(receiptLines(state(), false)).toEqual([])
  })
})

// A user-set hints.git_hint_max_ms, below the receipt's bound as the default 50 ms is: the stop warning asks within it and never within the longer one.
const HINT_MS = 1234

describe('one git status per stop, shared by the receipt and the stop warning', () => {
  let warnings: string[] = []
  beforeEach(() => {
    warnings = []
    vi.stubEnv('TOKEN_GOAT_GIT_HINT_MAX_MS', String(HINT_MS))
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '))
    })
  })

  it('a clean tree is asked once, and the receipt flag and the hallucination warning agree', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-once-'))
    bound.answer = CLEAN_TREE
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([GIT_STATUS_TIMEOUT_MS])
    expect(warnings).toEqual([`subagent-stop: possible hallucination — session=${sid} but git status is clean`])
    expect(JSON.stringify(await agentResult(sid, CLAIM))).toContain('recorded no edit')
  })

  it('a git that did not finish is asked once, and the receipt line and the stderr note agree', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-once-'))
    bound.answer = KILLED_GIT
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(warnings).toEqual([`subagent-stop: could not check the report against git status — session=${sid}, git did not finish`])
    expect(JSON.stringify(await agentResult(sid, CLAIM))).toContain(NOTE)
  })

  it('the stop warning asked alone leaves the event loop free while git is held, and asks within the hint bound', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-held-'))
    const held = heldGit()
    let settled = false
    const stopped = Promise.resolve(subagentStopHandler(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))).then(() => {
      settled = true
    })
    const endedFirst = stopped.then(() => {
      throw new Error('the stop handler finished while git was still to be held')
    })
    // The status call arrives at the seam and stays pending; the handler cannot have finished while it does, and the turn of the event loop that follows could only run because the handler left the loop free.
    await Promise.race([held.entered, endedFirst])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    held.release(KILLED_GIT)
    await stopped
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([HINT_MS])
    expect(warnings).toEqual([`subagent-stop: could not check the report against git status — session=${sid}, git did not finish`])
  })

  // The real runner, kept on purpose: either outcome of a git under the hint bound is accepted below (finished is clean, cut off is unchecked), so a slow git cannot fail the row, and what it pins is that the real runner, not a canned answer, handles the bound the stop warning hands it.
  it('the stop warning asked alone runs the real runner under the hint bound', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-real-'))
    git(repo, 'init', '-q')
    bound.passThrough = true
    await subagentStopHandler(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([HINT_MS])
    // A git slower than the bound reads as unfinished and a faster one as clean: either way exactly one warning, naming this session.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(new RegExp(`^subagent-stop: (possible hallucination|could not check the report against git status) — session=${sid}[ ,]`))
  })

  // On Copilot CLI the receipt handler stands aside and the rewrite handler, registered after the stop handler, builds the receipt: both reach for the same git status, and the answer one of them gets must serve the other.
  it('on Copilot CLI the stop warning and the report rewrite share one git status, the clean-tree line included', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-copilot-once-'))
    bound.answer = CLEAN_TREE
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([HINT_MS])
    expect(warnings).toEqual([`subagent-stop: possible hallucination — session=${sid} but git status is clean`])
    expect(JSON.stringify(out)).toContain('recorded no edit')
  })

  it('a user-set hint bound is what the stop warning hands the runner', async () => {
    vi.stubEnv('TOKEN_GOAT_GIT_HINT_MAX_MS', '777')
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-userbound-'))
    bound.answer = CLEAN_TREE
    await subagentStopHandler(buildEvent('subagent_stop', stopPayload(newSession(), repo, CLAIM)))
    expect(bound.timeouts).toEqual([777])
  })

  // On Copilot CLI the stop warning asks first, under the short hint bound; the rewrite is allowed the receipt's longer one and must not take a timeout of the shorter as its own answer.
  it('on Copilot CLI a timeout under the hint bound is not the rewrite\'s answer: it asks again under its own', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-copilot-held-'))
    bound.answer = KILLED_GIT
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(2)
    expect(bound.timeouts).toEqual([HINT_MS, GIT_STATUS_TIMEOUT_MS])
    expect(JSON.stringify(out)).toContain(NOTE)
  })

  it.each([
    ['Claude Code', undefined],
    ['Copilot CLI', 'copilot_cli'],
  ])('a dirty tree is asked once on %s, and nothing is said', async (_host, harness) => {
    if (harness !== undefined) vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', harness)
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-dirty-'))
    bound.answer = UNTRACKED_FILE
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(warnings).toEqual([])
    expect(JSON.stringify(out)).not.toContain('recorded no edit')
    expect(JSON.stringify(out)).not.toContain(NOTE)
    expect(JSON.stringify(await agentResult(sid, CLAIM))).not.toContain('recorded no edit')
  })
})

// HAND-DERIVED from src/git_async.ts::runGitAsync, which reports an output overflow, a refused spawn and an abort as exit -1 with no timedOut and the reason in stderr, and from src/util.ts::runGit/runGitAsync, which report a git killed by a signal as exit -1 with `unfinished` and the signal name (tests/git_did_not_finish.test.ts drives the real runners to both). A real 200 MiB overflow is not worth producing.
describe('a git that was cut off without a timeout', () => {
  let warnings: string[] = []
  beforeEach(() => {
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '))
    })
  })
  const OVERFLOW: GitResult = { stdout: '', stderr: 'spawn git ENOBUFS: output exceeded the 200 MiB buffer', unfinished: true, exitCode: -1 }
  const KILLED_BY_SIGNAL: GitResult = { stdout: '', stderr: 'git was killed by SIGKILL', unfinished: true, signal: 'SIGKILL', exitCode: -1 }
  const UNCHECKED_WARNING = (sid: string): string => `subagent-stop: could not check the report against git status — session=${sid}, git did not finish`

  it('reads as unchecked on the receipt and the stop warning, never as a clean tree', async () => {
    bound.answer = OVERFLOW
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-overflow-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(warnings).toEqual([UNCHECKED_WARNING(sid)])
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain(NOTE)
    expect(delivered).not.toContain('recorded no edit')
  })

  it('reads as unchecked on the Copilot CLI rewrite and the stop warning', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    bound.answer = OVERFLOW
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-overflow-copilot-'))
    const out = JSON.stringify(await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM))))
    expect(warnings).toEqual([UNCHECKED_WARNING(sid)])
    expect(out).toContain(NOTE)
    expect(out).not.toContain('recorded no edit')
  })

  it('reads as unchecked when the spawn itself was refused for a reason other than a missing git', async () => {
    bound.answer = { stdout: '', stderr: 'spawn git EACCES', unfinished: true, exitCode: -1 }
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-eacces-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(warnings).toEqual([UNCHECKED_WARNING(sid)])
  })

  it('words a git that overflowed its output as not finished, never as a git that was too slow', async () => {
    bound.answer = OVERFLOW
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-overflow-wording-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(warnings).toEqual([`subagent-stop: could not check the report against git status — session=${sid}, git did not finish`])
  })

  it('reads as unchecked when git was killed by a signal, since it ran and never answered', async () => {
    bound.answer = KILLED_BY_SIGNAL
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-signal-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(warnings).toEqual([UNCHECKED_WARNING(sid)])
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain(NOTE)
    expect(delivered).not.toContain('recorded no edit')
  })

  // Decision pinned, not endorsed: a git that exited with an error stays silent, since it answered; a missing git or a gone directory (ENOENT) stays silent as it always did.
  it.each<[string, GitResult]>([
    ['an error exit', { stdout: '', stderr: '', exitCode: 1, unfinished: false }],
    ['a missing git or a gone working directory', { stdout: '', stderr: 'spawn git ENOENT', exitCode: -1, unfinished: false }],
  ])('stays silent for %s', async (_what, answer) => {
    bound.answer = answer
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-silent-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(warnings).toEqual([])
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })
})
