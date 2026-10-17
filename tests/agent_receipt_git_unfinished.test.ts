// When `git status` does not finish, the subagent receipt says so instead of reading as a clean result. Provenance: the SubagentStop payload keys (session_id, cwd, agent_id, agent_type, stop_hook_active, last_assistant_message) are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (SubagentStop), the same source tests/agent_receipt.test.ts cites; the Agent tool result is a plain string there too. The git that never finishes is real git held by an event: a clean filter (gitattributes `filter=<name>` with `filter.<name>.clean`, git's documented way to run a command on a file's content, https://git-scm.com/docs/gitattributes) that blocks until a release file exists, run by `git status` on a tracked file whose content changed at the same size (CAPTURE: Git for Windows 2.53 here, a status over such a file ran the filter and was cut off with it at a 4 s timeout; a longer file was reported modified without running it, which is why the content is rewritten at the same length). Real runGitAsync, real registry: the only substitution is the bound, removed, so no machine speed can change the outcome. A case that must finish runs git with no time limit; the held case waits for the hold process to announce itself (an fs.watch event on its started log), then aborts the run through the product's own tree kill, and the seam reports that ended run as the timed-out answer a bound would have given (HAND-DERIVED: a killed git is `{ exitCode: -1, timedOut: true }` in src/types.ts::GitResult, while an abort reports neither).
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { runHook as RunHookFn } from '../src/hook_registry.js'
import type * as UtilModule from '../src/util.js'
import type { GitResult, RunGitAsyncOptions } from '../src/types.js'
import type { subagentStopHandler as SubagentStopHandlerFn } from '../src/agent_receipt.js'
import type { buildEvent as BuildEventFn } from '../src/relay.js'

import { killAllIfCommandLine } from './helpers/kill_if_command_line.js'
import { GIT_STATUS_TIMEOUT_MS, receiptLines } from '../src/agent_receipt.js'
import type { VerificationState } from '../src/verification_state.js'

const bound = vi.hoisted(() => ({ statusCalls: 0, timeouts: [] as unknown[], passThrough: false, abort: undefined as AbortController | undefined, answer: undefined as GitResult | undefined }))

// Every git status the receipt or the stop warning asks for is counted, sync or async. Async git runs with no time limit (GIT_UNBOUNDED), so a slow git is never read as a killed one; a run the test aborts is reported as the timed-out answer. The bound each status call asked for is recorded before it is replaced, and `passThrough` sends a call to the real runner untouched, and `answer` stands in for a result the real runner cannot be made to give.
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
      }
      if (bound.answer !== undefined) return bound.answer
      if (bound.passThrough) return actual.runGitAsyncLazy(args, opts)
      const abort = bound.abort
      const result = await actual.runGitAsyncLazy(args, { ...opts, timeoutMs: actual.GIT_UNBOUNDED, ...(abort ? { signal: abort.signal } : {}) })
      return abort?.signal.aborted === true ? { ...result, timedOut: true as const } : result
    },
  }
})

let runHook: typeof RunHookFn
let buildEvent: typeof BuildEventFn
let subagentStopHandler: typeof SubagentStopHandlerFn

const CLAIM = 'I fixed the parser bug.'
const NOTE = "git status did not finish, so this report's change claim was not checked."

/** One test's hold process files. Each test has its own, so a hold process that starts after its test ended still reads its own release file and exits, and never writes into the next test's log. */
interface Hold {
  readonly started: string
  readonly release: string
}

let toolDir = ''
let holdScript = ''
let repo = ''
let holdCounter = 0
let holds: Hold[] = []
// Every directory watch holdStarted opened, closed by afterEach so one that never saw its hold announce itself (a test that failed or timed out first) does not outlive its test.
let watchers: fs.FSWatcher[] = []

// HAND-DERIVED: the held process is the node run of the hold script, whose path is on its command line (spelled with either slash on Windows).
const isHoldCommandLine = (commandLine: string): boolean => commandLine.replaceAll('\\', '/').toLowerCase().includes(holdScript.toLowerCase())

beforeAll(() => {
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-hold-')).replaceAll(path.sep, '/')
  holdScript = `${toolDir}/hold.cjs`
  // argv[2] is the started log and argv[3] the release file. The held process ends when the release file exists (afterEach writes it), when its kill is asked for, or after two minutes.
  fs.writeFileSync(holdScript, [
    "const fs = require('node:fs')",
    'const [started, release] = process.argv.slice(2)',
    "fs.appendFileSync(started, process.pid + require('node:os').EOL)",
    'const wait = new Int32Array(new SharedArrayBuffer(4))',
    'const deadline = Date.now() + 120000',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 50)',
    'process.exit(0)',
    '',
  ].join('\n'))
})

afterAll(() => {
  fs.rmSync(toolDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A new set of hold files for one test, ended and swept by afterEach. */
function newHold(): Hold {
  const dir = `${toolDir}/h${holdCounter++}`
  fs.mkdirSync(dir)
  const hold = { started: `${dir}/started.log`, release: `${dir}/release` }
  holds.push(hold)
  return hold
}

const announcedPids = (hold: Hold): number[] =>
  fs.existsSync(hold.started) ? fs.readFileSync(hold.started, 'utf8').split('\n').filter((line) => line.trim() !== '').map(Number) : []

/** Resolves once the hold process of `hold` has written its pid line, from a directory watch event and one check made after the watch is in place, so neither order of events is missed. */
function holdStarted(hold: Hold): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => announcedPids(hold).length > 0
    const watcher = fs.watch(path.dirname(hold.started), () => {
      if (check()) {
        watcher.close()
        resolve()
      }
    })
    watchers.push(watcher)
    watcher.once('error', reject)
    if (check()) {
      watcher.close()
      resolve()
    }
  })
}

/** A repository whose one tracked file `git status` can only judge by running the hold filter: same length, new content. */
function repoHeldByFilter(hold: Hold): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-unfinished-'))
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=hold\n')
  git(dir, 'config', 'filter.hold.clean', `'${process.execPath.replaceAll(path.sep, '/')}' '${holdScript}' '${hold.started}' '${hold.release}'`)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n')
  return dir
}

beforeEach(async () => {
  vi.resetModules()
  runHook = (await import('../src/hook_registry.js')).runHook
  buildEvent = (await import('../src/relay.js')).buildEvent
  subagentStopHandler = (await import('../src/agent_receipt.js')).subagentStopHandler
  bound.statusCalls = 0
  bound.timeouts = []
  bound.passThrough = false
  bound.abort = undefined
  bound.answer = undefined
  holds = []
  watchers = []
})

afterEach(() => {
  try {
    // The release lets a held process that outlived its git end by itself; the pids it announced are ended too, but only while their command line is still the hold script, since a freed number may name another process by now.
    for (const hold of holds) fs.writeFileSync(hold.release, '')
    killAllIfCommandLine(holds.flatMap(announcedPids), isHoldCommandLine)
  } finally {
    for (const watcher of watchers) watcher.close()
    bound.abort = undefined
    bound.answer = undefined
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
const agentResult = (sid: string, text: string) => runHook(buildEvent('post_tool_use', { tool_name: 'Agent', tool_input: { prompt: 'Look into it.' }, session_id: sid, tool_response: text }))

/** Runs the stop hook over the repo held by `hold`'s filter, waits for the filter to have announced itself, then aborts git: the order is decided by those two events and no clock. Rejects when git ends before the filter started, which is a broken fixture and not a pass. */
async function stopWhileHeld(sid: string, hold: Hold): Promise<Awaited<ReturnType<typeof runHook>>> {
  const abort = new AbortController()
  bound.abort = abort
  const stopped = runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
  const endedFirst = stopped.then(() => {
    throw new Error('git ended before the hold filter started')
  })
  await Promise.race([holdStarted(hold), endedFirst])
  abort.abort()
  return stopped
}

const state = (overrides: Partial<VerificationState> = {}): VerificationState => ({ runs: [], failingUnresolved: false, editedFiles: [], editedAnyFile: false, editedSinceLastPass: [], ...overrides })

describe('a change claim whose git status did not finish', () => {
  it('gets one plain line through the real registry, not a clean result', async () => {
    const sid = newSession()
    const hold = newHold()
    repo = repoHeldByFilter(hold)
    await stopWhileHeld(sid, hold)
    expect(announcedPids(hold)).toHaveLength(1)
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain(NOTE)
    expect(delivered).not.toContain('recorded no edit')
  })

  it('is not said for a report that claims nothing, which needs no git at all', async () => {
    const sid = newSession()
    const hold = newHold()
    repo = repoHeldByFilter(hold)
    const message = 'The handler adds a header to each request.'
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, message)))
    expect((await agentResult(sid, message)).hookType).toBe('pass')
    expect(fs.existsSync(hold.started)).toBe(false)
    expect(bound.statusCalls).toBe(0)
  })

  it('is not said when git finishes: a clean tree still gets the clean-tree flag', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-unfinished-'))
    git(repo, 'init', '-q')
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain('recorded no edit')
    expect(delivered).not.toContain(NOTE)
  })

  it('is not said for a git that fails for another reason: a directory that is not a repository', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-norepo-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })

  it('is not said when git is missing from PATH', async () => {
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-nogit-'))
    git(repo, 'init', '-q')
    const empty = path.join(toolDir, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    vi.stubEnv('PATH', empty)
    try {
      await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    } finally {
      vi.unstubAllEnvs()
    }
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })

  it('a hold process that starts after its test ended writes only to its own files and ends by itself', async () => {
    const earlier = newHold()
    const later = newHold()
    fs.writeFileSync(earlier.release, '')
    const late = spawn(process.execPath, [holdScript, earlier.started, earlier.release], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        late.once('error', reject)
        late.once('exit', () => resolve())
      })
      expect(announcedPids(earlier)).toEqual([late.pid])
      expect(fs.existsSync(later.started)).toBe(false)
    } finally {
      if (late.exitCode === null && late.signalCode === null) late.kill()
    }
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
    git(repo, 'init', '-q')
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([GIT_STATUS_TIMEOUT_MS])
    expect(warnings).toEqual([`subagent-stop: possible hallucination — session=${sid} but git status is clean`])
    expect(JSON.stringify(await agentResult(sid, CLAIM))).toContain('recorded no edit')
  })

  it('a git that did not finish is asked once, and the receipt line and the stderr note agree', async () => {
    const sid = newSession()
    const hold = newHold()
    repo = repoHeldByFilter(hold)
    await stopWhileHeld(sid, hold)
    expect(bound.statusCalls).toBe(1)
    expect(warnings).toEqual([`subagent-stop: could not check the report against git status — session=${sid}, git did not answer in time`])
    expect(JSON.stringify(await agentResult(sid, CLAIM))).toContain(NOTE)
  })

  it('the stop warning asked alone leaves the event loop free while git is held, and asks within the hint bound', async () => {
    const sid = newSession()
    const hold = newHold()
    repo = repoHeldByFilter(hold)
    const abort = new AbortController()
    bound.abort = abort
    let settled = false
    const stopped = Promise.resolve(subagentStopHandler(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))).then(() => {
      settled = true
    })
    const endedFirst = stopped.then(() => {
      throw new Error('the stop handler finished while git was still to be held')
    })
    // The announcement is an fs.watch event: it can only be delivered to a loop the handler left free, and the handler cannot have finished while git is held.
    await Promise.race([holdStarted(hold), endedFirst])
    expect(settled).toBe(false)
    abort.abort()
    await stopped
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([HINT_MS])
    expect(warnings).toEqual([`subagent-stop: could not check the report against git status — session=${sid}, git did not answer in time`])
  })

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
    git(repo, 'init', '-q')
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(bound.timeouts).toEqual([HINT_MS])
    expect(warnings).toEqual([`subagent-stop: possible hallucination — session=${sid} but git status is clean`])
    expect(JSON.stringify(out)).toContain('recorded no edit')
  })

  it('a user-set hint bound is what the stop warning hands the runner', async () => {
    vi.stubEnv('TOKEN_GOAT_GIT_HINT_MAX_MS', '777')
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-userbound-'))
    git(repo, 'init', '-q')
    await subagentStopHandler(buildEvent('subagent_stop', stopPayload(newSession(), repo, CLAIM)))
    expect(bound.timeouts).toEqual([777])
  })

  // On Copilot CLI the stop warning asks first, under the short hint bound; the rewrite is allowed the receipt's longer one and must not take a timeout of the shorter as its own answer.
  it('on Copilot CLI a timeout under the hint bound is not the rewrite\'s answer: it asks again under its own', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    const sid = newSession()
    const hold = newHold()
    repo = repoHeldByFilter(hold)
    const out = await stopWhileHeld(sid, hold)
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
    git(repo, 'init', '-q')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n')
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(bound.statusCalls).toBe(1)
    expect(warnings).toEqual([])
    expect(JSON.stringify(out)).not.toContain('recorded no edit')
    expect(JSON.stringify(out)).not.toContain(NOTE)
    expect(JSON.stringify(await agentResult(sid, CLAIM))).not.toContain('recorded no edit')
  })
})

// HAND-DERIVED from src/git_async.ts::runGitAsync, which reports an output overflow, a refused spawn and an abort as exit -1 with no timedOut and the reason in stderr, and from src/util.ts::runGit/runGitAsync, which report a git killed by a signal as exit 1 (`code ?? 1`), the same as any error exit. A real 200 MiB overflow is not worth producing.
describe('a git that was cut off without a timeout', () => {
  let warnings: string[] = []
  beforeEach(() => {
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '))
    })
  })
  const OVERFLOW: GitResult = { stdout: '', stderr: 'spawn git ENOBUFS: output exceeded the 200 MiB buffer', exitCode: -1 }
  const UNCHECKED_WARNING = (sid: string): string => `subagent-stop: could not check the report against git status — session=${sid}, git did not answer in time`

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
    bound.answer = { stdout: '', stderr: 'spawn git EACCES', exitCode: -1 }
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-eacces-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(warnings).toEqual([UNCHECKED_WARNING(sid)])
  })

  // Decision pinned, not endorsed: both runners report a git killed by a signal as exit 1, so it cannot be told from an error exit and stays silent like one; a missing git or a gone directory (ENOENT) stays silent as it always did.
  it.each([
    ['an error exit that a signal kill also reports', { stdout: '', stderr: '', exitCode: 1 }],
    ['a missing git or a gone working directory', { stdout: '', stderr: 'spawn git ENOENT', exitCode: -1 }],
  ] as Array<[string, GitResult]>)('stays silent for %s', async (_what, answer) => {
    bound.answer = answer
    const sid = newSession()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-silent-'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    expect(warnings).toEqual([])
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })
})
