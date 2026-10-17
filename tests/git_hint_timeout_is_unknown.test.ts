// Provenance: a git killed at its time bound is `{ exitCode: -1, timedOut: true }` (src/types.ts::GitResult, the Node 24.12 ETIMEDOUT CAPTURE in src/util.ts::runGit); a git that ran and refused is a non-zero exit without timedOut (HAND-DERIVED, `fatal: not a git repository` is exit 128). The `.git/HEAD` bytes are git's documented `ref: refs/heads/<name>` line (gitrepository-layout(5)), written by hand; the real-layout side is tests/git_hint_branch_read.test.ts. A slow git is injected as a runGit that answers "killed at the bound" for every call, which is what a git slower than hints.git_hint_max_ms is; the real timeout path is tests/run_git_default_timeout.test.ts and tests/run_git_timeout_reaps_git.test.ts. The runGit stand-in answers at once, so nothing here waits on a clock.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as util from '../src/util.js'

const git = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; timeoutMs: unknown }>,
  answer: (_args: readonly string[]): unknown => undefined as unknown,
}))
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof util>()
  return {
    ...actual,
    runGit: (args: string[], opts?: { timeoutMs?: unknown }) => {
      git.calls.push({ args, timeoutMs: opts?.timeoutMs })
      return git.answer(args)
    },
  }
})

import { subagentStopHandler } from '../src/agent_receipt.js'
import { importSessionState, recordFileEdit, recordFileRead } from '../src/session.js'
import { saveSessionState } from '../src/session_store.js'
import { buildManifest } from '../src/manifest.js'
import { userPromptSubmitHandler } from '../src/hooks_session.js'
import type { HookEvent } from '../src/hook_registry.js'

const KILLED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, timedOut: true }
const REFUSED: GitResult = { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
const ok = (stdout: string): GitResult => ({ stdout, stderr: '', exitCode: 0 })
const HINT_BUDGET_MS = 50

const dirs: string[] = []
let savedGitDir: string | undefined

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-unknown-'))
  dirs.push(dir)
  return dir
}

/** A folder with a `.git` directory whose HEAD reads `head`. */
function repoWithHead(head: string): string {
  const dir = scratch()
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head)
  return dir
}

beforeEach(() => {
  git.calls = []
  git.answer = () => KILLED
  savedGitDir = process.env['GIT_DIR']
  delete process.env['GIT_DIR']
  importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedGitDir === undefined) delete process.env['GIT_DIR']
  else process.env['GIT_DIR'] = savedGitDir
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function promptEvent(cwd: string): HookEvent {
  return { eventName: 'user_prompt_submit', toolName: undefined, toolInput: {}, sessionId: 'git-unknown-prompt', agentId: undefined, raw: { prompt: 'this is a long enough prompt to pass the length check', cwd } }
}

function contextOf(result: Awaited<ReturnType<typeof userPromptSubmitHandler>>): string {
  return result.hookType === 'context' ? (result as { context: string }).context : ''
}

describe('the branch hint on a git that is slower than the hint budget', () => {
  it('still names the branch, and starts no git, when HEAD is readable', async () => {
    const cwd = repoWithHead('ref: refs/heads/feature/slow-pc\n')
    expect(contextOf(await userPromptSubmitHandler(promptEvent(cwd)))).toContain('branch: feature/slow-pc')
    expect(git.calls).toEqual([])
  })

  it('names HEAD for a detached HEAD, as git does, with no git started', async () => {
    const cwd = repoWithHead(`${'a'.repeat(40)}\n`)
    expect(contextOf(await userPromptSubmitHandler(promptEvent(cwd)))).toContain('branch: HEAD')
    expect(git.calls).toEqual([])
  })

  it('asks git, inside the hint budget, only when HEAD cannot be read, and gives no branch when that git is killed', async () => {
    const cwd = repoWithHead('garbled\n')
    expect(contextOf(await userPromptSubmitHandler(promptEvent(cwd)))).not.toContain('branch:')
    expect(git.calls).toEqual([{ args: ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs: HINT_BUDGET_MS }])
  })

  it('uses git for the branch when HEAD cannot be read and git answers', async () => {
    git.answer = () => ok('from-git\n')
    const cwd = repoWithHead('ref: refs/heads/.invalid\n')
    expect(contextOf(await userPromptSubmitHandler(promptEvent(cwd)))).toContain('branch: from-git')
  })
})

describe('the subagent stop check on a git that is slower than the hint budget', () => {
  const REPORT = 'I updated the config to fix the crash'
  let warnings: string[] = []

  beforeEach(() => {
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '))
    })
  })

  function stop(cwd: string): void {
    subagentStopHandler({ eventName: 'subagent_stop', toolName: undefined, toolInput: {}, sessionId: 'git-unknown-stop', agentId: undefined, raw: { cwd, last_assistant_message: REPORT } })
  }

  it('says the check did not finish: not a hallucination warning, and not silence', () => {
    stop(scratch())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/could not check the report against git status/)
    expect(warnings[0]).toMatch(/did not answer in time/)
    expect(warnings[0]).not.toMatch(/possible hallucination/)
    expect(git.calls).toEqual([{ args: ['status', '--porcelain'], timeoutMs: HINT_BUDGET_MS }])
  })

  it('still warns of a hallucination when git answers clean', () => {
    git.answer = () => ok('')
    stop(scratch())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/possible hallucination/)
  })

  it('says nothing when git shows a dirty tree', () => {
    git.answer = () => ok(' M src/a.ts\n')
    stop(scratch())
    expect(warnings).toEqual([])
  })

  it('says nothing when git refuses, as before: that is not a timeout', () => {
    git.answer = () => REFUSED
    stop(scratch())
    expect(warnings).toEqual([])
  })
})

describe('the manifest on a git that is slower than the hint budget', () => {
  /** A session whose manifest is well past the default 1600-character cap, so the cap engages and the dirty-state probe is consulted. */
  function seedLongSession(sessionId: string): void {
    // Several edits: the adaptive budget's git bonus is scaled by the session's activity, and with none it rounds away.
    for (let i = 0; i < 5; i++) recordFileEdit(`/proj/src/edited-${i}.ts`)
    for (let i = 0; i < 45; i++) recordFileRead(`/proj/src/read-only-file-number-${i}.ts`)
    saveSessionState(sessionId)
  }

  function truncatedAt(manifest: string): number {
    const match = /manifest truncated at (\d+) chars/.exec(manifest)
    expect(match, 'the cap must engage, or this asserts on a manifest that never consulted the probe').not.toBeNull()
    return Number(match![1])
  }

  it('says the git state is unknown when both probes are killed, instead of reading it as clean', () => {
    seedLongSession('manifest-killed')
    const manifest = buildManifest('manifest-killed', repoWithHead('ref: refs/heads/main\n'))
    expect(manifest).toMatch(/git did not answer in time/)
    expect(truncatedAt(manifest)).toBe(1600)
    expect(git.calls.map((c) => [c.args[0], c.timeoutMs])).toEqual([['diff', HINT_BUDGET_MS], ['status', HINT_BUDGET_MS]])
  })

  it('does not say it for a clean tree', () => {
    git.answer = () => ok('')
    seedLongSession('manifest-clean')
    const manifest = buildManifest('manifest-clean', repoWithHead('ref: refs/heads/main\n'))
    expect(manifest).not.toMatch(/git did not answer/)
    expect(truncatedAt(manifest)).toBe(1600)
  })

  it('does not say it for a refusal', () => {
    git.answer = () => REFUSED
    seedLongSession('manifest-refused')
    expect(buildManifest('manifest-refused', repoWithHead('ref: refs/heads/main\n'))).not.toMatch(/git did not answer/)
  })

  it('gives a dirty tree its room and does not claim the git state is unknown', () => {
    git.answer = (args) => ok(args[0] === 'status' ? ' M src/a.ts\n' : '')
    seedLongSession('manifest-dirty')
    const manifest = buildManifest('manifest-dirty', repoWithHead('ref: refs/heads/main\n'))
    expect(truncatedAt(manifest)).toBeGreaterThan(1600)
    expect(manifest).not.toMatch(/git did not answer/)
  })

  it('says it when only the status probe is killed and the diff probe found nothing', () => {
    git.answer = (args) => (args[0] === 'status' ? KILLED : ok(''))
    seedLongSession('manifest-half')
    expect(buildManifest('manifest-half', repoWithHead('ref: refs/heads/main\n'))).toMatch(/git did not answer in time/)
  })
})
