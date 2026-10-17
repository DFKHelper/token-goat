// When `git status` does not finish, the subagent receipt says so instead of reading as a clean result. Provenance: the SubagentStop payload keys (session_id, cwd, agent_id, agent_type, stop_hook_active, last_assistant_message) are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (SubagentStop), the same source tests/agent_receipt.test.ts cites; the Agent tool result is a plain string there too. The git that never finishes is real git held by an event: a clean filter (gitattributes `filter=<name>` with `filter.<name>.clean`, git's documented way to run a command on a file's content, https://git-scm.com/docs/gitattributes) that blocks until a release file exists, run by `git status` on a tracked file whose content changed at the same size (CAPTURE: Git for Windows 2.53 here, a status over such a file ran the filter and was cut off with it at a 4 s timeout; a longer file was reported modified without running it, which is why the content is rewritten at the same length). Real spawnSync, real runGit, real registry: the only substitution is the wall-clock bound, shortened because the held git never answers whatever its length, so no machine speed can change the outcome.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { runHook as RunHookFn } from '../src/hook_registry.js'
import type * as UtilModule from '../src/util.js'
import type { RunGitOptions } from '../src/util.js'
import type { buildEvent as BuildEventFn } from '../src/relay.js'

import { killAllIfCommandLine } from './helpers/kill_if_command_line.js'
import { receiptLines } from '../src/agent_receipt.js'
import type { VerificationState } from '../src/verification_state.js'

const bound = vi.hoisted(() => ({ ms: null as number | null }))

// The product bounds `git status` at 5 s. The held git below never answers, so any bound ends it; a short one keeps the case quick. A null bound leaves the product's own, for the cases that run an unheld git.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[], opts: RunGitOptions = {}) => actual.runGit(args, bound.ms === null ? opts : { ...opts, timeoutMs: bound.ms }),
  }
})

let runHook: typeof RunHookFn
let buildEvent: typeof BuildEventFn

const CLAIM = 'I fixed the parser bug.'
const NOTE = "git status did not finish, so this report's change claim was not checked."

let toolDir = ''
let holdScript = ''
let startedLog = ''
let releaseFile = ''
let repo = ''

// HAND-DERIVED: the held process is the node run of the hold script, whose path is on its command line (spelled with either slash on Windows).
const isHoldCommandLine = (commandLine: string): boolean => commandLine.replaceAll('\\', '/').toLowerCase().includes(holdScript.toLowerCase())

beforeAll(() => {
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-hold-')).replaceAll(path.sep, '/')
  startedLog = `${toolDir}/started.log`
  releaseFile = `${toolDir}/release`
  holdScript = `${toolDir}/hold.cjs`
  // The held process ends when the release file exists (afterEach writes it), when its kill is asked for, or after two minutes.
  fs.writeFileSync(holdScript, [
    "const fs = require('node:fs')",
    `fs.appendFileSync(${JSON.stringify(startedLog)}, process.pid + require('node:os').EOL)`,
    'const wait = new Int32Array(new SharedArrayBuffer(4))',
    'const deadline = Date.now() + 120000',
    `while (!fs.existsSync(${JSON.stringify(releaseFile)}) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 50)`,
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

/** A repository whose one tracked file `git status` can only judge by running the hold filter: same length, new content. */
function repoHeldByFilter(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-unfinished-'))
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=hold\n')
  git(dir, 'config', 'filter.hold.clean', `'${process.execPath.replaceAll(path.sep, '/')}' '${holdScript}'`)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n')
  return dir
}

beforeEach(async () => {
  vi.resetModules()
  runHook = (await import('../src/hook_registry.js')).runHook
  buildEvent = (await import('../src/relay.js')).buildEvent
  fs.rmSync(startedLog, { force: true })
  fs.rmSync(releaseFile, { force: true })
})

afterEach(() => {
  try {
    // The release lets a held process that outlived its git end by itself; the pids it announced are ended too, but only while their command line is still the hold script, since a freed number may name another process by now.
    fs.writeFileSync(releaseFile, '')
    const pids = fs.existsSync(startedLog) ? fs.readFileSync(startedLog, 'utf8').split('\n').filter((line) => line.trim() !== '').map(Number) : []
    killAllIfCommandLine(pids, isHoldCommandLine)
  } finally {
    bound.ms = null
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

const state = (overrides: Partial<VerificationState> = {}): VerificationState => ({ runs: [], failingUnresolved: false, editedFiles: [], editedAnyFile: false, editedSinceLastPass: [], ...overrides })

describe('a change claim whose git status did not finish', () => {
  it('gets one plain line through the real registry, not a clean result', async () => {
    const sid = newSession()
    repo = repoHeldByFilter()
    bound.ms = 300
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, CLAIM)))
    bound.ms = null
    const delivered = JSON.stringify(await agentResult(sid, CLAIM))
    expect(delivered).toContain(NOTE)
    expect(delivered).not.toContain('recorded no edit')
    expect(fs.existsSync(startedLog), 'the held filter must be what git was running').toBe(true)
  })

  it('is not said for a report that claims nothing, which needs no git at all', async () => {
    const sid = newSession()
    repo = repoHeldByFilter()
    const message = 'The handler adds a header to each request.'
    bound.ms = 300
    await runHook(buildEvent('subagent_stop', stopPayload(sid, repo, message)))
    bound.ms = null
    expect((await agentResult(sid, message)).hookType).toBe('pass')
    expect(fs.existsSync(startedLog)).toBe(false)
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

  it('sits beside the other lines instead of replacing them', () => {
    const failed = { command: 'npm test', exitCode: 1, at: 0 }
    const lines = receiptLines(state({ failingUnresolved: true, latestRun: failed, runs: [failed] }), false, true)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(`token-goat: ${NOTE}`)
    expect(receiptLines(state(), false)).toEqual([])
  })
})
