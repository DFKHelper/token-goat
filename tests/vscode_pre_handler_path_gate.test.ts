/** On VS Code, no pre_tool_use handler a built-in tool reaches may stat or read a network, device, or out-of-workspace path. VS Code runs PreToolUse hooks before it asks the user to approve the call, so whatever path the model names is untrusted until then, and on Windows even a stat of a UNC path opens an SMB connection to that host. This sweeps the live registry through handlersFor rather than a hand-kept list, so a handler added later for one of these tools is swept too, and a floor on the handler count fails if the sweep ever finds nothing. node:fs is wrapped with pass-through recorders; a UNC or device path throws inside the wrapper instead of reaching the real fs, so no network access happens even on unfixed code. PROVENANCE: FORMAT-DERIVED. The canonical tool names are the values of VSCODE_TOOL_NAME_MAP in src/hooks_cli.ts, whose VS Code names (read_file, view_image, list_dir, grep_search, file_search, create_file, replace_string_in_file, insert_edit_into_file, edit_notebook_file) come from the languageModelTools entries in VS Code 1.136.0's resources/app/extensions/copilot/package.json, and the 1.137.0 additions (multi_replace_string_in_file, apply_patch, fetch_webpage, runSubagent, get_terminal_output) from that release's extension.js ToolName enum and workbench.desktop.main.js, as cited on VSCODE_TOOL_NAME_MAP and VSCODE_INPUT_KEY_MAP. With a workspace folder open, VS Code resolves the hook's cwd to that folder and the payload carries it; with no folder open it resolves none, omits the key, and spawns the hook in the home directory. (Those two halves are exclusive, so the earlier claim here -- no cwd AND the workspace folder -- described a state that cannot occur. Read from VS Code 1.136.0's bundled agentHostMain.js and workbench.desktop.main.js: FORMAT-DERIVED, not CAPTURE, since no live payload was captured.) Here the event carries the workspace as cwd directly; tests/vscode_folderless_cwd_gate.test.ts covers the folderless case through the real normalizePayload. Paths and file contents are HAND-DERIVED. */
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

/** Every canonical tool a VS Code built-in tool maps to, Bash included. Bash used to be filtered out of this population, with the rationale that `run_in_terminal` carries a command rather than a path. It carries about twenty paths, which `hooks_bash.ts` extracts OUT OF the command and two of which it stats -- so the one tool excluded from the sweep was the one whose handler had never been brought inside the rule. A sweep whose population is built by a filter is only as good as the filter, and this one narrowed itself by tool name in a line nothing else pointed at. */
const TOOLS = [...new Set(Object.values(VSCODE_TOOL_NAME_MAP))].sort()
const NATIVE_FOR: Record<string, string> = Object.fromEntries(Object.entries(VSCODE_TOOL_NAME_MAP).map(([native, canonical]) => [canonical, native]))

/** The directory part of a path in either separator, and its last segment, for spelling a target as `cd DIR && ... FILE`. */
function splitLast(target: string): [string, string] {
  const at = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return at < 0 ? ['.', target] : [target.slice(0, at), target.slice(at + 1)]
}

/** The Bash command shapes whose pre hook handling stats or reads the file they name, each spelled around `target`. Bash carries a command rather than a path, and each shape is a path the handler extracts from it and looks at before the command is approved: the `powershell -Command` Get-Content wrapper's temp-file size check, the `sed`/`awk` range loop, the pricing of a leading-lines read behind `head -n`, `Get-Content -TotalCount` and `Select-Object -First`, a `cd` that moves where a relative file resolves, and the structural `rg`/`grep` rewrite. The sweep held only the first, and the others stat-ed a share unasked. PROVENANCE: CAPTURE (Windows 11, node 24.14.0, 2026-09-27). The loop 71 bundle's pre hook, run as `token-goat hook pre_tool_use` on the default harness with each command naming a file on its own unreachable host, so Windows' cache of a failed host could not answer a later probe early, took 21,176 to 21,245 ms for each shape after the first, the whole SMB connect timeout, against 134 to 240 ms for `head -n 5`, `tail -n 300` and `cat` of a file on a share and 139 ms for a local `head -n 5`. The fixed bundle answered each in 136 to 187 ms. The paths here are HAND-DERIVED. */
const BASH_SHAPES: ReadonlyArray<readonly [string, (target: string) => string]> = [
  ['a powershell -Command Get-Content wrapper', (t) => `powershell -Command "Get-Content '${t}'"`],
  ['a sed range', (t) => `sed -n '1,5p' '${t}'`],
  ['an awk range', (t) => `awk 'NR>=1 && NR<=5' '${t}'`],
  ['head -n 300', (t) => `head -n 300 '${t}'`],
  ['Get-Content -TotalCount', (t) => `Get-Content '${t}' -TotalCount 300`],
  ['Get-Content piped to Select-Object -First', (t) => `Get-Content '${t}' | Select-Object -First 300`],
  ['a sed range after a cd', (t) => `cd '${splitLast(t)[0]}' && sed -n '1,5p' ${splitLast(t)[1]}`],
  ['head -n 300 after a cd', (t) => `cd '${splitLast(t)[0]}' && head -n 300 ${splitLast(t)[1]}`],
  ['a structural rg', (t) => `rg "^export function" '${t}'`],
  ['a structural grep', (t) => `grep "^import" '${t}'`],
]

function vscodeEvent(toolName: string, target: string, bashShape: (target: string) => string = BASH_SHAPES[0]![1]): HookEvent {
  // Every path key any of these tools' handlers reads, so each handler is offered the target whichever key it looks at. Bash reads none of them: it takes `command`, so the target is spelled into one of BASH_SHAPES, the powershell wrapper unless the caller names another.
  const toolInput = toolName === 'Bash'
    ? { command: bashShape(target) }
    : { file_path: target, path: target, notebook_path: target, pattern: 'value1', content: LINES.replace('value1 = 1', 'value1 = 2'), old_string: 'a', new_string: 'b' }
  return makeHookEvent({ eventName: 'pre_tool_use', toolName, toolInput, sessionId: `gate-${Math.random().toString(36).slice(2)}`, raw: { tool_name: toolName, tool_input: toolInput, cwd: workspace, _tg_harness: 'vscode', [VSCODE_TOOL_NAME_KEY]: NATIVE_FOR[toolName] } })
}

/** The recorded fs calls that reached `target`, which a relative target names as resolved against the workspace, the cwd every event here carries: compared unresolved, the path that climbs out of the workspace could never match a call, since each call is resolved before the comparison. */
function hitsOf(target: string, seen: readonly string[]): string[] {
  const want = /^[\\/]{2}/.test(target) ? null : normalizePath(path.resolve(workspace, target))
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
    expect(TOOLS).toEqual(['Bash', 'BashOutput', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'NotebookEdit', 'Read', 'Task', 'WebFetch', 'Write'])
    // Read: preReadHandler + preReadImageHandler; Grep: preReadHandler + preGrepHandler; Glob: preGlobHandler; Write: preWriteRewriteHandler; Bash: preBashHandler (toolName-filtered ones only; unfiltered handlers such as the MCP ones add to every tool).
    const filtered = TOOLS.reduce((n, t) => n + handlersFor('pre_tool_use', t).length, 0) - TOOLS.length * handlersFor('pre_tool_use', 'tg-no-such-tool').length
    expect(filtered).toBeGreaterThanOrEqual(7)
  })
})

describe.each(TOOLS)('every pre_tool_use handler for %s on VS Code', (tool) => {
  it.each(DECLINED)('makes no fs call on %s', async (_label, target) => {
    const handlers = handlersFor('pre_tool_use', tool)
    for (const [shapeLabel, shape] of tool === 'Bash' ? BASH_SHAPES : BASH_SHAPES.slice(0, 1)) {
      const label = tool === 'Bash' ? `${tool} (${shapeLabel})` : tool
      for (const [i, handler] of handlers.entries()) {
        touched.length = 0
        try {
          await handler(vscodeEvent(tool, target(), shape))
        } catch {
          // A throw is not the property under test; only what reached fs is.
        }
        expect(hitsOf(target(), touched), `handler #${i} (${handler.name || 'anonymous'}) for ${label}`).toEqual([])
      }
      touched.length = 0
      const full = await runHook(vscodeEvent(tool, target(), shape))
      // Bash is the one tool whose refusal is not a pass. Declining to TOUCH the path does not stop it emitting the surgical-read hint that names it, which costs no fs call and is the whole point of the handler; every other tool here has nothing left to say once the path is out.
      if (tool !== 'Bash') expect(full).toEqual({ hookType: 'pass' })
      expect(hitsOf(target(), touched), `the full registry for ${label}`).toEqual([])
    }
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

  // The calibration for the Bash shapes the sweep above runs: each still reaches the in-workspace file, so a green sweep is the gate declining and not a shape that stopped matching. Relative, because the extractors drop an absolute path under the temp directory this workspace sits in. The powershell wrapper measures only a temp file, and its calibration is the last case in this file.
  it.each(BASH_SHAPES.slice(1))('Bash still looks at an in-workspace file behind %s', async (_label, shape) => {
    touched.length = 0
    await runHook(vscodeEvent('Bash', './module.ts', shape))
    expect(hitsOf(insideFile, touched).length).toBeGreaterThan(0)
  })

  it('the same Write on another harness is unaffected by the gate', async () => {
    const event = vscodeEvent('Write', outsideFile)
    const claude = { ...event, raw: { tool_name: 'Write', tool_input: event.toolInput, cwd: workspace } }
    const out = await runHook(claude)
    expect(out.hookType).toBe('context')
  })
})

/** The two PowerShell command shapes in `hooks_bash.ts` whose temp-file check reached the filesystem, each against the payload that used to get through: a path under a network share spelled so it ends in `AppData/Local/Temp`. The rest of BASH_SHAPES follow them, on this harness rather than VS Code, as the capture that found them ran. The sweep above proves the handler makes no fs call. These two prove WHICH gate stops it, and the third is the calibration: the identical command naming a real local temp file is measured, so a green pair above cannot be the extractors having quietly stopped matching. PROVENANCE: HAND-DERIVED. The commands are the two shapes `extractPowerShellWrappedGetContent` and `extractPowerShellFileMethodRead` document; the share path is composed by hand to satisfy the substring test the temp-path check used to apply, and names a host that does not resolve. */
describe('a command naming a path on a network share is never stat-ed before approval', () => {
  const SHARE = String.raw`\\tg-no-such-host\share\AppData\Local\Temp\notes.md`

  function bashEvent(command: string): HookEvent {
    const toolInput = { command }
    return makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Bash', toolInput, sessionId: `bash-${Math.random().toString(36).slice(2)}`, raw: { tool_name: 'Bash', tool_input: toolInput, cwd: workspace } })
  }

  it.each([
    ['a powershell -Command Get-Content wrapper', `powershell -Command "Get-Content '${SHARE}'"`],
    ['a .NET static file read', `[IO.File]::ReadAllText('${SHARE}')`],
  ])('makes no fs call for %s', async (_label, command) => {
    touched.length = 0
    await runHook(bashEvent(command))
    expect(touched.filter((t) => t.includes('tg-no-such-host'))).toEqual([])
  })

  // A call on a path spelled as a share is what must not happen, the spelling the wrapper refuses. Linux and macOS read `//host/share` as the local `/host/share`, which a handler may stat as it would any absent file: the Linux run of this file on the fixed code saw both cd shapes do so.
  it.each(BASH_SHAPES.slice(1))('makes no fs call for %s naming a file on a share', async (_label, shape) => {
    touched.length = 0
    await runHook(bashEvent(shape('//tg-no-such-host/share/x.ts')))
    expect(touched.filter((t) => /^[\\/]{2}/.test(t))).toEqual([])
  })

  it('calibration: the same command naming a local temp file IS measured, so the refusal above is the share', async () => {
    const localTemp = path.join(fsReal.realpathSync(os.tmpdir()), `tg-gate-${process.pid}-notes.md`)
    fsReal.writeFileSync(localTemp, LINES)
    try {
      touched.length = 0
      await runHook(bashEvent(`powershell -Command "Get-Content '${localTemp}'"`))
      expect(touched.some((t) => normalizePath(t) === normalizePath(localTemp))).toBe(true)
    } finally {
      fsReal.rmSync(localTemp, { force: true })
    }
  })
})
