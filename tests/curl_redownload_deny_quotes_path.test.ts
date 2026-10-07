/** The deny for a repeated `curl -o` download suggests `rg '<pattern>' <path>` to search the saved file, and wrote the path raw: a project directory holding `$` and a zero-width space reached the model as `rg '<pattern>' C:/…/p$MARK<U+200B>/out.json`, where the shell expands `$MARK`, splits at the space, and the invisible character rides along. The path is now quoted with quotedArg after displaySafePath. Provenance: HAND-DERIVED directory name built from the shell rules; the curl command is only handed to the hook handlers, never to a shell, and names the reserved example.invalid host. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { quotedArg, stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { displaySafePath, normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

let root: string

beforeEach(() => {
  clearModuleCaches()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-curl-p $MARK\u200B-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function bashEvent(sid: string, eventName: 'pre_tool_use' | 'post_tool_use', command: string): HookEvent {
  const raw: Record<string, unknown> = { cwd: root, tool_name: 'Bash', tool_input: { command } }
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
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

function text(out: HookOutput): string {
  return out.hookType === 'deny' ? out.message : ''
}

describe('the repeated curl -o download deny', () => {
  it('quotes the saved path in its rg suggestion, so the relay keeps it and a shell reads one argument', async () => {
    fs.writeFileSync(path.join(root, 'out.json'), JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row ${i}` })) }))
    const command = 'curl -sS -o out.json https://example.invalid/data.json'
    const sid = `s-curl-quote-${process.pid}-${Math.random().toString(36).slice(2)}`
    await asHook(sid, () => postBashHandler(bashEvent(sid, 'post_tool_use', command)))
    const again = await asHook(sid, () => preBashHandler(bashEvent(sid, 'pre_tool_use', command)))
    const message = text(again)
    expect(again.hookType).toBe('deny')
    const rg = /`(rg [^`]*)`/.exec(message)?.[1] ?? ''
    const saved = normalizePath(path.join(root, 'out.json'))
    expect(rg).toBe(`rg '<pattern>' ${quotedArg(displaySafePath(saved))}`)
    expect(rg).toContain('$MARK\\u200b')
    expect(stripUnsafeSuggestions(rg)).toBe(rg)
  })
})
