/** A resident hook server answers a second caller while the first caller's git read is still running. src/hooks_bash_post.ts read git with the synchronous runGit, so a git that took its 5 s budget froze the server's event loop: a status or stop request, or another hook call, sat unread until it ended. The reads now go through runGitAsync, and this holds one of them open with a deferred promise (no clock) to show the loop stays free. Provenance: HAND-DERIVED. The request shapes are src/hook_ipc.ts::ServerRequest, the Bash payload is the PostToolUse shape tests/helpers/hook-event.ts builds, and the deferred git result is a git that exits 0 with an empty diff. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as GitAsyncModule from '../src/git_async.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const seam = vi.hoisted(() => ({ gitStarted: undefined as (() => void) | undefined, gitResult: undefined as Promise<unknown> | undefined, asked: [] as string[][] }))

vi.mock('../src/git_async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitAsyncModule>()
  return {
    ...actual,
    runGitAsync: (args: string[]) => {
      seam.asked.push(args)
      seam.gitStarted?.()
      return seam.gitResult as Promise<GitResult>
    },
  }
})

import { callServer, queryServers } from '../src/hook_client.js'
import { envSnapshot } from '../src/hook_ipc.js'
import { runHookServer } from '../src/hook_server.js'

let cwd: string

beforeEach(() => {
  vi.stubEnv('TOKEN_GOAT_HOOK_SERVER', '1')
  // The server asks for its own exit once told to stop; the test process must outlive that.
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pending-git-'))
  seam.asked = []
})

afterEach(async () => {
  await queryServers('stop')
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('the resident hook server while a hook call waits on git', () => {
  it('answers a status request and refuses a second hook call before the first call finishes', async () => {
    const gitStarted = deferred<void>()
    const gitResult = deferred<GitResult>()
    seam.gitStarted = gitStarted.resolve
    seam.gitResult = gitResult.promise

    await runHookServer(0, async () => undefined)

    const payload = { session_id: 'pending-git', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git checkout feature' }, tool_response: { stdout: "Switched to branch 'feature'\n", stderr: '', interrupted: false }, cwd }
    const first = callServer({ kind: 'hook', event: 'post_tool_use', input: JSON.stringify(payload), elapsedMs: 0, env: envSnapshot(), cwd }, { autostart: false })
    const firstSettled = first.then(() => 'answered' as const)

    // Either the hook reached its git read and is waiting on it, or it was answered without ever asking for one (a synchronous read, or the call never reached the server).
    const reached = await Promise.race([gitStarted.promise.then(() => 'waiting' as const), firstSettled])
    expect(reached, 'the first hook call must be parked on its git read').toBe('waiting')
    expect(seam.asked[0]).toEqual(expect.arrayContaining(['diff', '--name-only']))

    const statuses = await queryServers('status')
    expect(statuses, 'the one server answers a status request while its hook call waits on git').toHaveLength(1)
    const reply = statuses[0]?.reply
    expect(reply).toMatchObject({ ok: true, info: { served: 0 } })

    const second = await callServer({ kind: 'hook', event: 'post_tool_use', input: JSON.stringify(payload), elapsedMs: 0, env: envSnapshot(), cwd }, { autostart: false })
    expect(second, 'a second hook call is turned away at once, not left unread').toBeUndefined()
    expect(seam.asked, 'the turned-away call never reached git').toHaveLength(1)

    gitResult.resolve({ stdout: '', stderr: '', exitCode: 0 })
    expect(await first).toMatchObject({ ok: true })
  })
})
