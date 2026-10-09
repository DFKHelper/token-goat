/** The Copilot CLI shim's tool-name maps are plain object literals, so a bare lookup answers for every name on `Object.prototype`. `resolveCanonicalToolName` read `TOOL_TO_TG[name]` and `TOOL_TO_TG[stripped]` directly and treated any non-`undefined` result as a mapping. For a tool called `constructor`, `toString`, `valueOf` or `hasOwnProperty` that result is an inherited *function*, which is truthy, so the resolver returned it as the canonical tool name. `JSON.stringify` omits function-valued properties, so the payload forwarded to token-goat then carried no `tool_name` at all and every hook keyed on one no-opped. The key is not ours to choose: Copilot CLI namespaces MCP tools as `server:tool` and the shim strips to the half after the colon, which is whatever a third-party server named its tool. The shim's event map one function over already guards with `Object.prototype.hasOwnProperty.call` and documents this exact class; the tool-name and argument-key maps beside it did not. Provenance: CAPTURE. The fake token-goat records the shim's real stdin, so the assertions are on the bytes a shipped shim sends rather than on a re-derivation of what it ought to send. */

import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { describe, it, expect, afterAll } from 'vitest'

import { writeInProcessFake } from './helpers/copilot_inprocess_fake.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'

const tempDirs: string[] = []

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** What the shim forwarded to token-goat, recorded by a fake that answers through the shim's in-process route (an entry path plus a sibling token-goat-hook.mjs), so no child process has to finish inside the shim's 3000 ms spawn timeout; the forwarded tool name is part of the canonical payload that route receives. */
function withCapturingTokenGoat(cwd: string): { entryPath: string; captured: () => Record<string, unknown> | undefined } {
  const capturePath = path.join(cwd, 'captured-stdin.json')
  const entryPath = writeInProcessFake(cwd, { capturePath })
  return {
    entryPath,
    captured: () => {
      if (!fs.existsSync(capturePath)) return undefined
      try {
        return JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
      } catch {
        return undefined
      }
    },
  }
}

/** Run the shim once against a fresh isolated directory and return what it forwarded to token-goat. */
function forward(toolName: string, toolArgs: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'tg-copilot-proto-'))
  tempDirs.push(cwd)
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  const { entryPath, captured } = withCapturingTokenGoat(cwd)
  spawnSync(process.execPath, [scriptPath, 'preToolUse', entryPath], {
    cwd,
    input: JSON.stringify({ sessionId: 'proto-session', toolName, toolArgs }),
    encoding: 'utf8',
    timeout: 60000,
    env: process.env,
  })
  return captured()
}

describe('Copilot CLI shim given a tool named after an Object.prototype member', () => {
  // Every name here resolves to an inherited function through a bare lookup. __proto__ is the one that resolves to an object rather than a function, so it survives JSON.stringify and forwards a whole prototype where a tool name belongs.
  const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__']

  it.each(INHERITED)('forwards %s as its own literal name', (name) => {
    const payload = forward(name)
    expect(payload).toBeDefined()
    expect(payload?.['tool_name']).toBe(name)
  })

  it('strips an MCP namespace without resolving the inherited half', () => {
    // Copilot CLI namespaces MCP tools server:tool, and the shim resolves the stripped half too -- so the inherited name arrives from a third-party server rather than from the user typing it.
    const payload = forward('github:toString')
    expect(payload).toBeDefined()
    expect(payload?.['tool_name']).toBe('github:toString')
  })

  it('still resolves a real tool name, so the guard did not close the map', () => {
    const payload = forward('read_powershell', { shellId: 'abc' })
    expect(payload?.['tool_name']).toBe('BashOutput')
    expect((payload?.['tool_input'] as Record<string, unknown>)['bash_id']).toBe('abc')
  })

  it('remaps a path argument for a namespaced view tool', () => {
    const payload = forward('local:view', { path: '/proj/a.ts' })
    expect(payload?.['tool_name']).toBe('Read')
    expect((payload?.['tool_input'] as Record<string, unknown>)['file_path']).toBe('/proj/a.ts')
  })
})
