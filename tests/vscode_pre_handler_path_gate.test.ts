/**
 * On VS Code, no pre_tool_use handler a built-in tool reaches may stat or read a network, device, or out-of-workspace path.
 *
 * VS Code runs PreToolUse hooks before it asks the user to approve the call, so whatever path the model names is untrusted until then, and on Windows even a stat of a UNC path opens an SMB connection to that host. This sweeps the live registry through handlersFor rather than a hand-kept list, so a handler added later for one of these tools is swept too, and a floor on the handler count fails if the sweep ever finds nothing. node:fs is wrapped with pass-through recorders; a UNC or device path throws inside the wrapper instead of reaching the real fs, so no network access happens even on unfixed code.
 *
 * PROVENANCE: FORMAT-DERIVED. The canonical tool names are the values of VSCODE_TOOL_NAME_MAP in src/hooks_cli.ts, whose VS Code names (read_file, view_image, list_dir, grep_search, file_search, create_file, replace_string_in_file, insert_edit_into_file, edit_notebook_file) come from the languageModelTools entries in VS Code 1.136.0's resources/app/extensions/copilot/package.json, as cited on VSCODE_INPUT_KEY_MAP. With a workspace folder open, VS Code resolves the hook's cwd to that folder and the payload carries it; with no folder open it resolves none, omits the key, and spawns the hook in the home directory. (Those two halves are exclusive, so the earlier claim here -- no cwd AND the workspace folder -- described a state that cannot occur. Read from VS Code 1.136.0's bundled agentHostMain.js and workbench.desktop.main.js: FORMAT-DERIVED, not CAPTURE, since no live payload was captured.) Here the event carries the workspace as cwd directly; tests/vscode_folderless_cwd_gate.test.ts covers the folderless case through the real normalizePayload. Paths and file contents are HAND-DERIVED.
 */
import * as fsReal from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const touched = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof fsReal>()
  const record = <F>(fn: F): F =>
    ((...args: unknown[]) => {
      const p = args[0]
      if (typeof p === 'string') {
        touched.push(p)
        if (/^[\\/]{2}/.test(p)) throw Object.assign(new Error(`ENOENT: test wrapper refused ${p}`), { code: 'ENOENT' })
      }
      return (fn as (...a: unknown[]) => unknown)(...args)
    }) as F
  const overrides = {
    statSync: record(orig.statSync),
    lstatSync: record(orig.lstatSync),
    readFileSync: record(orig.readFileSync),
    openSync: record(orig.openSync),
    existsSync: record(orig.existsSync),
    accessSync: record(orig.accessSync),
    readdirSync: record(orig.readdirSync),
    realpathSync: Object.assign(record(orig.realpathSync), { native: record(orig.realpathSync.native) }),
  }
  return { ...orig, ...overrides, default: { ...orig, ...overrides } }
})

import '../src/relay.js'
import { VSCODE_TOOL_NAME_KEY, VSCODE_TOOL_NAME_MAP } from '../src/hooks_cli.js'
import { handlersFor, runHook } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'
import { normalizePath } from '../src/paths.js'
import { makeHookEvent } from './helpers/hook-event.js'

let base: string
let workspace: string
let outsideFile: string
let insideFile: string

// A 200-line file, so the Write handler's unchanged-lines hint has something to compare against when it is allowed to look.
const LINES = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i}`).join('\n') + '\n'

beforeAll(() => {
  base = fsReal.realpathSync.native(fsReal.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-gate-')))
  workspace = path.join(base, 'workspace')
  fsReal.mkdirSync(workspace)
  fsReal.mkdirSync(path.join(base, 'elsewhere'))
  outsideFile = path.join(base, 'elsewhere', 'module.ts')
  insideFile = path.join(workspace, 'module.ts')
  fsReal.writeFileSync(outsideFile, LINES)
  fsReal.writeFileSync(insideFile, LINES)
})

afterAll(() => {
  fsReal.rmSync(base, { recursive: true, force: true })
})

/** Every canonical tool a VS Code built-in tool maps to, except Bash: run_in_terminal carries a command, not a path. */
const TOOLS = [...new Set(Object.values(VSCODE_TOOL_NAME_MAP))].filter((t) => t !== 'Bash').sort()
const NATIVE_FOR: Record<string, string> = Object.fromEntries(Object.entries(VSCODE_TOOL_NAME_MAP).map(([native, canonical]) => [canonical, native]))

function vscodeEvent(toolName: string, target: string): HookEvent {
  // Every path key any of these tools' handlers reads, so each handler is offered the target whichever key it looks at.
  const toolInput = { file_path: target, path: target, notebook_path: target, pattern: 'value1', content: LINES.replace('value1 = 1', 'value1 = 2'), old_string: 'a', new_string: 'b' }
  return makeHookEvent({ eventName: 'pre_tool_use', toolName, toolInput, sessionId: `gate-${Math.random().toString(36).slice(2)}`, raw: { tool_name: toolName, tool_input: toolInput, cwd: workspace, _tg_harness: 'vscode', [VSCODE_TOOL_NAME_KEY]: NATIVE_FOR[toolName] } })
}

function hitsOf(target: string, seen: readonly string[]): string[] {
  const want = /^[\\/]{2}/.test(target) ? null : normalizePath(target)
  return seen.filter((p) => (want === null ? p.includes('tg-no-such') : normalizePath(path.resolve(workspace, p)) === want))
}

const DECLINED: ReadonlyArray<[string, () => string]> = [
  ['a UNC path', () => '\\\\tg-no-such-host\\share\\module.ts'],
  ['a forward-slash UNC path', () => '//tg-no-such-host/share/module.ts'],
  ['an extended-length device path', () => '\\\\?\\C:\\tg-no-such-dir\\module.ts'],
  ['a device namespace path', () => '\\\\.\\C:\\tg-no-such-dir\\module.ts'],
  ['a file outside the workspace', () => outsideFile],
  ['a relative path that climbs out of the workspace', () => path.join('..', 'elsewhere', 'module.ts')],
]

describe('the sweep finds the handlers it is meant to cover', () => {
  it('has at least the six path-carrying registrations for these tools', () => {
    expect(TOOLS).toEqual(['Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Write'])
    // Read: preReadHandler + preReadImageHandler; Grep: preReadHandler + preGrepHandler; Glob: preGlobHandler; Write: preWriteRewriteHandler (toolName-filtered ones only; unfiltered handlers such as the MCP ones add to every tool).
    const filtered = TOOLS.reduce((n, t) => n + handlersFor('pre_tool_use', t).length, 0) - TOOLS.length * handlersFor('pre_tool_use', 'tg-no-such-tool').length
    expect(filtered).toBeGreaterThanOrEqual(6)
  })
})

describe.each(TOOLS)('every pre_tool_use handler for %s on VS Code', (tool) => {
  it.each(DECLINED)('makes no fs call on %s', async (_label, target) => {
    const handlers = handlersFor('pre_tool_use', tool)
    for (const [i, handler] of handlers.entries()) {
      touched.length = 0
      try {
        await handler(vscodeEvent(tool, target()))
      } catch {
        // A throw is not the property under test; only what reached fs is.
      }
      expect(hitsOf(target(), touched), `handler #${i} (${handler.name || 'anonymous'}) for ${tool}`).toEqual([])
    }
    touched.length = 0
    expect(await runHook(vscodeEvent(tool, target()))).toEqual({ hookType: 'pass' })
    expect(hitsOf(target(), touched), `the full registry for ${tool}`).toEqual([])
  })
})

describe('an in-workspace path is still looked at', () => {
  it('Read still stats the file, and Write still gives its unchanged-lines hint', async () => {
    touched.length = 0
    await runHook(vscodeEvent('Read', insideFile))
    expect(hitsOf(insideFile, touched).length).toBeGreaterThan(0)
    const write = await runHook(vscodeEvent('Write', insideFile))
    expect(write.hookType).toBe('context')
    if (write.hookType === 'context') expect(write.context).toContain('200-line file')
  })

  it('the same Write on another harness is unaffected by the gate', async () => {
    const event = vscodeEvent('Write', outsideFile)
    const claude = { ...event, raw: { tool_name: 'Write', tool_input: event.toolInput, cwd: workspace } }
    const out = await runHook(claude)
    expect(out.hookType).toBe('context')
  })
})
