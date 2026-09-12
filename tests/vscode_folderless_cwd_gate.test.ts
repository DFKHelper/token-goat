/**
 * With no workspace folder open, the VS Code path gate must not fall back to the home directory.
 *
 * WHY THIS WAS OPEN. VS Code resolves a hook's `cwd` to the workspace folder when one is open, and
 * the payload carries it. With NO folder open it resolves none, omits the key entirely, and spawns
 * the hook process in the user's home directory. `normalizePayload` filled the missing key from
 * `process.cwd()` -- which in that situation IS the home directory -- and `vscodePathDeclined` then
 * took it as the confinement root, so every path under `$HOME` was permitted. VS Code runs
 * PreToolUse hooks BEFORE asking the user to approve the call, so a model-named `~/.ssh/id_rsa`
 * would have been stat'd and read without approval.
 *
 * WHY NO TEST CAUGHT IT, and what now does. The repo's recorded injected-seam trap: every existing
 * test supplied the very thing the shipping path omits. tests/vscode_pre_handler_path_gate.test.ts
 * hardcodes `cwd: workspace` into each event, and tests/vscode_image_path_confinement.test.ts
 * chdirs into the workspace instead -- so neither ever produced a payload with no `cwd`. Building
 * the event by hand does not reproduce it either: with the key absent `getCwd` returns `undefined`
 * and `vscodePathAllowed` already fails closed, so such a test passes against BROKEN code. The
 * defect only appears through the real `normalizePayload`, which is what manufactures the root.
 * That is why this file drives it, and why it chdirs to the home directory: with `process.cwd()`
 * left as the repo, a `$HOME` target is outside it and the assertion passes for the wrong reason.
 *
 * Scope. This covers the gate's ROOT DECISION, which is where the defect lives. That every
 * path-carrying handler routes through the gate at all is already swept in
 * tests/vscode_pre_handler_path_gate.test.ts, so it is not restated here.
 *
 * FIXTURE PROVENANCE:
 *  - The VS Code payload envelope (`hook_event_name`, `tool_name: 'read_file'`, `tool_input.filePath`)
 *    is FORMAT-DERIVED, matching the `vscodePayload` helper in tests/hooks_cli.test.ts and the
 *    VSCODE_INPUT_KEY_MAP citation on src/hooks_cli.ts.
 *  - The folderless behaviour it models (no `cwd` resolved, key omitted, process spawned in
 *    `homedir()`) is FORMAT-DERIVED from VS Code 1.136.0's bundled `agentHostMain.js` and
 *    `workbench.desktop.main.js`. It is explicitly NOT capture-grade: no live folderless payload was
 *    obtained, so the mechanism is evidenced from the shipped bundle rather than from an observed
 *    run, and the real-world frequency of the folderless case is unverified.
 *  - Paths are HAND-DERIVED and name files that do not exist, so nothing here reads real secrets.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { normalizePayload } from '../src/hooks_cli.js'
import { vscodePathDeclined } from '../src/vscode_path_gate.js'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'

const savedCwd = process.cwd()
let workspace: string

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-folderless-ws-'))
})

afterAll(() => {
  process.chdir(savedCwd)
  fs.rmSync(workspace, { recursive: true, force: true })
})

/** A VS Code PreToolUse payload for a path-carrying tool, put through the real normalizePayload. `cwd` is omitted entirely when `cwd` is undefined, which is the folderless shape. */
function vscodeEvent(target: string, cwd: string | undefined): HookEvent {
  const payload = {
    timestamp: '2026-09-11T00:00:00.000Z',
    hook_event_name: 'PreToolUse',
    session_id: 'folderless',
    tool_name: 'read_file',
    tool_input: { filePath: target },
    tool_use_id: 'tu-1',
    ...(cwd === undefined ? {} : { cwd }),
  }
  const raw = normalizePayload(payload, 'vscode')
  return makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Read', toolInput: raw['tool_input'] as Record<string, unknown>, sessionId: 'folderless', raw })
}

describe('the VS Code path gate with no workspace folder open', () => {
  it('declines a path under the home directory, because the cwd was synthesized rather than sent', () => {
    // Reproduces where VS Code actually starts the hook when no folder is open. Without this chdir
    // process.cwd() is the repo, a $HOME target is outside it, and the assertion would pass on
    // unfixed code for entirely the wrong reason.
    process.chdir(os.homedir())
    const target = path.join(os.homedir(), 'tg-no-such-secret.txt')
    expect(vscodePathDeclined(vscodeEvent(target, undefined), target)).toBe(true)
  })

  it('still declines an unrelated absolute path in the same folderless state', () => {
    process.chdir(os.homedir())
    const target = path.join(os.homedir(), '.ssh', 'tg-no-such-key')
    expect(vscodePathDeclined(vscodeEvent(target, undefined), target)).toBe(true)
  })

  it('CALIBRATION: allows an in-workspace path when the harness really sent a cwd', () => {
    // The positive control. Without it, a gate that declined everything -- or a probe that built a
    // malformed event -- would satisfy the two assertions above while proving nothing.
    process.chdir(savedCwd)
    const target = path.join(workspace, 'module.ts')
    expect(vscodePathDeclined(vscodeEvent(target, workspace), target)).toBe(false)
  })

  it('still declines a path outside a real harness-supplied workspace', () => {
    process.chdir(savedCwd)
    const target = path.join(os.tmpdir(), 'tg-no-such-elsewhere', 'module.ts')
    expect(vscodePathDeclined(vscodeEvent(target, workspace), target)).toBe(true)
  })
})
