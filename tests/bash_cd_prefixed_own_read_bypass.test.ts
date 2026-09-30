// DL-42: Claude Code's shim, and the hook server's copy of its check, skip the pre hook for a Bash call that is token-goat's own single command, cd prefixes included, so no start directory is held for it and the post hook fell back to its own cwd. On the main thread that is where the cd already moved the shell, so behind a relative target the cd was applied twice: `cd sub && token-goat read x.ts::foo` went on record against sub/sub/x.ts, a file that does not exist, and a repeat naming sub/x.ts was not recognised.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

// HAND-DERIVED: a module whose `foo` the surgical read names.
const LINES = Array.from({ length: 80 }, (_, i) => (i === 0 ? 'export function foo(): number { return 1 }' : `export const value${i} = ${i} * 2`))
const BODY = LINES.join('\n')
const REPEAT_NOTE = 'You already ran this exact `token-goat read` query'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A root holding a `sub` directory; `withRootCopy` also puts an x.ts in root, the file a cd that did not move the shell would leave a relative target naming. */
function layout(withRootCopy = false): { root: string; sub: string } {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cd-own-read-')))
  dirs.push(root)
  const sub = normalizePath(path.join(root, 'sub'))
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(sub, 'x.ts'), BODY)
  if (withRootCopy) fs.writeFileSync(path.join(root, 'x.ts'), BODY)
  return { root, sub }
}

function newSession(): string {
  return `s-cd-own-read-${process.pid}-${Math.random().toString(36).slice(2)}`
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

// CAPTURE: the envelope and the Bash tool_response keys { stdout, stderr, interrupted, isImage, noOutputExpected } are Claude Code's, recorded off real traffic in tests/hooks_real_harness_payload_shape.test.ts; tool_use_id rides on both hooks of one call (tests/bash_cd_prefixed_read_session_key.test.ts, Claude Code 2.1.281).
function bashEvent(sid: string, cwd: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', stdout = '', toolUseId?: string): HookEvent {
  const raw: Record<string, unknown> = { cwd, tool_name: 'Bash', tool_input: { command }, ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}) }
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
}

/** The post hook alone, under a tool_use_id no pre hook saw: the shape of a call the shim's own-command bypass let through (bridges/shim_common.ts::SHIM_OWN_COMMAND_BYPASS). */
async function bypassedPost(sid: string, postCwd: string, command: string): Promise<void> {
  const toolUseId = `toolu_${Math.random().toString(36).slice(2)}`
  await asHook(sid, () => postBashHandler(bashEvent(sid, postCwd, command, 'post_tool_use', LINES[0], toolUseId)))
}

function text(result: HookOutput): string {
  return result.hookType === 'context' ? result.context : ''
}

async function pre(sid: string, cwd: string, command: string): Promise<string> {
  return text(await asHook(sid, () => preBashHandler(bashEvent(sid, cwd, command, 'pre_tool_use'))))
}

describe('DL-42: a cd-prefixed token-goat read whose pre hook the shim skipped is keyed on the file the cd landed on', () => {
  it('main thread: the post cwd is already where the cd went, so the cd is not applied a second time', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    // CAPTURE (Claude Code 2.1.281, see bashEvent): on the main thread the post hook of `cd sub && ...` reports sub as its cwd.
    await bypassedPost(sid, sub, 'cd sub && token-goat read x.ts::foo')

    expect(await pre(sid, root, 'token-goat read sub/x.ts::foo')).toContain(REPEAT_NOTE)
    expect(await pre(sid, root, 'token-goat read sub/sub/x.ts::foo')).not.toContain(REPEAT_NOTE)
  })

  it('subagent: the post cwd is where the call started, so the cd is applied once as before', async () => {
    clearModuleCaches()
    const { root } = layout()
    const sid = newSession()
    await bypassedPost(sid, root, 'cd sub && token-goat read x.ts::foo')

    expect(await pre(sid, root, 'token-goat read sub/x.ts::foo')).toContain(REPEAT_NOTE)
  })

  it('a file under both readings keeps the one the cd names from the post cwd', async () => {
    clearModuleCaches()
    const { root } = layout(true)
    const sid = newSession()
    // The harness moved the shell back (a subagent, or a cd out of the working directories): post cwd is root, and root/x.ts exists too, so only the cd tells the two apart.
    await bypassedPost(sid, root, 'cd sub && token-goat read x.ts::foo')

    expect(await pre(sid, root, 'token-goat read sub/x.ts::foo')).toContain(REPEAT_NOTE)
    expect(await pre(sid, root, 'token-goat read x.ts::foo')).not.toContain(REPEAT_NOTE)
  })

  it('a held start directory still wins over both', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    const toolUseId = `toolu_${Math.random().toString(36).slice(2)}`
    await asHook(sid, () => preBashHandler(bashEvent(sid, root, 'cd sub && token-goat read x.ts::foo', 'pre_tool_use', '', toolUseId)))
    await asHook(sid, () => postBashHandler(bashEvent(sid, sub, 'cd sub && token-goat read x.ts::foo', 'post_tool_use', LINES[0], toolUseId)))

    expect(await pre(sid, root, 'token-goat read sub/x.ts::foo')).toContain(REPEAT_NOTE)
  })

  it('a held start directory is kept even where the file is missing and the post cwd has one', async () => {
    clearModuleCaches()
    const { root, sub } = layout(true)
    fs.rmSync(path.join(sub, 'x.ts'))
    const sid = newSession()
    const toolUseId = `toolu_${Math.random().toString(36).slice(2)}`
    await asHook(sid, () => preBashHandler(bashEvent(sid, root, 'cd sub && token-goat read x.ts::foo', 'pre_tool_use', '', toolUseId)))
    await asHook(sid, () => postBashHandler(bashEvent(sid, root, 'cd sub && token-goat read x.ts::foo', 'post_tool_use', LINES[0], toolUseId)))

    expect(await pre(sid, root, 'token-goat read x.ts::foo')).not.toContain(REPEAT_NOTE)
    expect(await pre(sid, root, 'token-goat read sub/x.ts::foo')).toContain(REPEAT_NOTE)
  })
})
