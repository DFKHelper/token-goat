/**
 * No pre_tool_use handler stats a UNC or device path, on any harness.
 *
 * The gate that rejects `\\server\share` used to sit behind a VS-Code check, so on every other
 * harness a `Read` of a model-chosen UNC path reached `fs.statSync` and Windows dialled the named
 * host. Measured 2026-09-13 through `preReadHandler` on a default-harness event:
 * `\\10.255.255.1\share\x.txt` took 21.0 s -- an SMB connect timeout -- against 21 ms for a local
 * control. VS Code is where the pre-approval window is guaranteed, but it is not the only place it
 * exists: any tool call the user has not pre-approved is still pending when the hook runs, and a
 * hook that dials out on the model's say-so is an SSRF primitive whichever client is driving.
 *
 * Only the UNC/device half is harness-independent. Workspace containment stays VS-Code-scoped,
 * because only VS Code supplies a workspace folder to be contained by --
 * tests/vscode_pre_handler_path_gate.test.ts covers that half, and the last case here pins that an
 * ordinary out-of-project path is still looked at elsewhere, so this fix is not a blanket refusal.
 *
 * PROVENANCE: the tool names are the canonical ones the live registry is keyed on, read from
 * handlersFor rather than a list, so a handler added later is swept too. The UNC and device path
 * spellings are HAND-DERIVED. As in the sibling sweep, node:fs is wrapped so a UNC path throws
 * inside the wrapper and no network access happens even against unfixed code.
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
import { handlersFor, runHook } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'

let base: string
let project: string
let outsideFile: string

const LINES = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i}`).join('\n') + '\n'

beforeAll(() => {
  base = fsReal.realpathSync.native(fsReal.mkdtempSync(path.join(os.tmpdir(), 'tg-unc-gate-')))
  project = path.join(base, 'project')
  fsReal.mkdirSync(project)
  fsReal.mkdirSync(path.join(base, 'elsewhere'))
  outsideFile = path.join(base, 'elsewhere', 'module.ts')
  fsReal.writeFileSync(outsideFile, LINES)
})

afterAll(() => {
  fsReal.rmSync(base, { recursive: true, force: true })
})

const TOOLS = ['Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Write'] as const

/** A default-harness (Claude Code) PreToolUse event: no `_tg_harness`, no VS Code tool-name key. */
function plainEvent(toolName: string, target: string): HookEvent {
  const toolInput = { file_path: target, path: target, notebook_path: target, pattern: 'value1', content: LINES.replace('value1 = 1', 'value1 = 2'), old_string: 'a', new_string: 'b' }
  return makeHookEvent({ eventName: 'pre_tool_use', toolName, toolInput, sessionId: `unc-${Math.random().toString(36).slice(2)}`, raw: { tool_name: toolName, tool_input: toolInput, cwd: project } })
}

const DECLINED: ReadonlyArray<[string, string]> = [
  ['a UNC path', '\\\\tg-no-such-host\\share\\module.ts'],
  ['a forward-slash UNC path', '//tg-no-such-host/share/module.ts'],
  ['an extended-length device path', '\\\\?\\C:\\tg-no-such-dir\\module.ts'],
  ['a device namespace path', '\\\\.\\C:\\tg-no-such-dir\\module.ts'],
]

/** Every fs argument that names the target host or device, whatever separators the caller used. */
function hitsOf(target: string, seen: readonly string[]): string[] {
  const needle = target.replace(/\\/g, '/').replace(/^\/+/, '')
  return seen.filter((p) => p.replace(/\\/g, '/').replace(/^\/+/, '').startsWith(needle))
}

describe('the sweep is not vacuous', () => {
  it('finds a path-carrying handler for each tool', () => {
    const unfiltered = handlersFor('pre_tool_use', 'tg-no-such-tool').length
    for (const tool of TOOLS) expect(handlersFor('pre_tool_use', tool).length, tool).toBeGreaterThan(unfiltered - 1)
    expect(TOOLS.reduce((n, t) => n + handlersFor('pre_tool_use', t).length, 0) - TOOLS.length * unfiltered).toBeGreaterThanOrEqual(6)
  })
})

describe.each(TOOLS)('every pre_tool_use handler for %s off VS Code', (tool) => {
  it.each(DECLINED)('makes no fs call on %s', async (_label, target) => {
    for (const [i, handler] of handlersFor('pre_tool_use', tool).entries()) {
      touched.length = 0
      try {
        await handler(plainEvent(tool, target))
      } catch {
        // Only what reached fs is under test.
      }
      expect(hitsOf(target, touched), `handler #${i} (${handler.name || 'anonymous'}) for ${tool}`).toEqual([])
    }
    touched.length = 0
    expect(await runHook(plainEvent(tool, target))).toEqual({ hookType: 'pass' })
    expect(hitsOf(target, touched), `the full registry for ${tool}`).toEqual([])
  })
})

describe('the harness-independent half declines only the network and device forms', () => {
  it('still lets an ordinary path outside the project through, so this is not a blanket refusal', async () => {
    touched.length = 0
    const out = await runHook(plainEvent('Write', outsideFile))
    expect(out.hookType, 'the unchanged-lines hint stopped firing off VS Code').toBe('context')
    expect(hitsOf(outsideFile, touched).length, 'the handler never looked at the file it reported on').toBeGreaterThan(0)
  })
})
