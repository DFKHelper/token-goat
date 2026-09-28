// A package-manager script behind a `cd DIR &&` prefix was matched to an output filter through the package.json nearest the hook's cwd rather than the one in the directory the cd moves the shell to. In a workspace whose packages test with different runners, `cd packages/a && npm test` run from the root was wrapped for compression under whatever the root's scripts named, and the post hook's pass over the same command piped into `tail` read the root's scripts too wherever its cwd is where the call started, as in a subagent. Both hooks now resolve the script in the directory the command runs in, the base its cached output is already keyed on.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

// HAND-DERIVED: a passing Jest run as its default reporter prints it uncoloured into a pipe, one `PASS <file>` line per suite and then the `Test Suites:` / `Tests:` summary, the lines jestjs.io/docs/getting-started shows for its sample run. What this file pins is which filter is chosen, so the fixture only has to be a run the jest filter recognizes.
const JEST_RUN = [
  ...Array.from({ length: 60 }, (_, i) => `PASS src/module${i}.test.js`),
  'Test Suites: 60 passed, 60 total',
  'Tests:       240 passed, 240 total',
  'Snapshots:   0 total',
  'Time:        6.42 s',
  'Ran all test suites.',
].join('\n')

// CAPTURE: tests/fixtures/bench/vitest-run.txt, `npx vitest run ... --reporter=verbose` run in this repository and redirected verbatim, provenance in vitest-run.json beside it.
const VITEST_RUN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bench', 'vitest-run.txt'), 'utf8')

const dirs: string[] = []
const ORIG_BC = process.env['TOKEN_GOAT_BASH_COMPRESS']

beforeEach(() => {
  clearModuleCaches()
  // Compression on whatever the ambient shell exports, since the rewrite under test is compression's.
  delete process.env['TOKEN_GOAT_BASH_COMPRESS']
  invalidateConfigCache()
})

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  if (ORIG_BC === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
  else process.env['TOKEN_GOAT_BASH_COMPRESS'] = ORIG_BC
  invalidateConfigCache()
})

// HAND-DERIVED from npm's workspaces documentation: a private root naming `packages/*` as its workspaces and holding no test script of its own, and two packages whose `test` scripts name different runners.
function workspace(): { root: string; pkgA: string; pkgB: string } {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cd-script-filter-')))
  dirs.push(root)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }))
  const pkgA = normalizePath(path.join(root, 'packages', 'a'))
  const pkgB = normalizePath(path.join(root, 'packages', 'b'))
  fs.mkdirSync(pkgA, { recursive: true })
  fs.mkdirSync(pkgB, { recursive: true })
  fs.writeFileSync(path.join(pkgA, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'jest' } }))
  fs.writeFileSync(path.join(pkgB, 'package.json'), JSON.stringify({ name: 'b', scripts: { test: 'vitest run' } }))
  return { root, pkgA, pkgB }
}

function newSession(): string {
  return `s-cd-script-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, handle and save per hook call, as relay.ts runs it. */
async function asHook<T>(sid: string, handle: () => T | Promise<T>): Promise<T> {
  loadSessionState(sid)
  try {
    return await handle()
  } finally {
    saveSessionState(sid)
  }
}

interface Call {
  readonly toolUseId?: string
  readonly agentId?: string
}

// CAPTURE: Claude Code 2.1.281 running `cd sub && pwd` on the main thread and inside a subagent, with hooks writing each payload to a file: the main thread's PreToolUse cwd was the directory the call started in and its PostToolUse cwd the one the cd left the shell in, a subagent's cwd was its start directory on both events, and each call carried one tool_use_id on both.
const SUBAGENT: Call = { agentId: 'a3fa4da94f851e86f' }

// CAPTURE: the envelope and the Bash tool_response keys { stdout, stderr, interrupted, isImage, noOutputExpected } are Claude Code's, recorded off real traffic in tests/hooks_real_harness_payload_shape.test.ts; Claude Code reports no exit code there, so none is sent.
function bashEvent(sid: string, cwd: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', stdout: string, call: Call): HookEvent {
  const raw: Record<string, unknown> = { cwd, tool_name: 'Bash', tool_input: { command } }
  if (call.toolUseId !== undefined) raw['tool_use_id'] = call.toolUseId
  if (call.agentId !== undefined) raw['agent_id'] = call.agentId
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: call.agentId, raw }
}

/** The command the pre hook replaced the call's with, or null when it left the call alone. */
async function wrapped(sid: string, cwd: string, command: string, call: Call = SUBAGENT): Promise<unknown> {
  const out = await asHook(sid, () => preBashHandler(bashEvent(sid, cwd, command, 'pre_tool_use', '', call)))
  return out.hookType === 'rewriteInput' ? out.updatedInput['command'] : null
}

/** The body the post hook replaced the call's output with, or '' when it passed the output through. */
async function rewritten(sid: string, cwd: string, command: string, stdout: string, call: Call = SUBAGENT): Promise<string> {
  const out: HookOutput = await asHook(sid, () => postBashHandler(bashEvent(sid, cwd, command, 'post_tool_use', stdout, call)))
  return out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
}

describe('a cd-prefixed package script is matched to a filter through the package the cd moves the shell to', () => {
  it('the pre hook wraps each package test run under the runner that package names', async () => {
    const { root, pkgA } = workspace()
    const sid = newSession()
    expect(await wrapped(sid, root, 'cd packages/a && npm test')).toBe("token-goat compress -f jest --timeout 600 -c 'cd packages/a && npm test'")
    expect(await wrapped(sid, root, 'cd packages/b && npm test')).toBe("token-goat compress -f vitest --timeout 600 -c 'cd packages/b && npm test'")
    // Positive control: with no cd, the hook's own cwd is where the script runs, so it still decides.
    expect(await wrapped(sid, pkgA, 'npm test')).toBe("token-goat compress -f jest --timeout 600 -c 'npm test'")
  })

  it('the post hook compresses a piped subagent run with the runner that package names', async () => {
    const { root } = workspace()
    const sid = newSession()
    expect(await rewritten(sid, root, 'cd packages/a && npm test 2>&1 | tail -n 200', JEST_RUN)).toContain('[token-goat: jest filter')
    expect(await rewritten(sid, root, 'cd packages/b && npm test 2>&1 | tail -n 200', VITEST_RUN)).toContain('[token-goat: vitest filter')
  })

  it('the post hook on the main thread, whose cwd is already where the cd left the shell, does not apply the cd a second time', async () => {
    const { pkgB } = workspace()
    const src = normalizePath(path.join(pkgB, 'src'))
    fs.mkdirSync(src)
    const sid = newSession()
    // Started inside package b, so the cd applied a second time, against the directory it left the shell in, would look the script up through the workspace root's package.json, which names no test script.
    const command = 'cd .. && npm test 2>&1 | tail -n 200'
    const call = { toolUseId: 'toolu_cd_script_1' }
    // The pre hook holds the directory the call started in, and the post event reports the one the cd left the shell in.
    await wrapped(sid, src, command, call)
    expect(await rewritten(sid, pkgB, command, VITEST_RUN, call)).toContain('[token-goat: vitest filter')
  })
})
