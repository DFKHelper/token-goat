// An unwrapped command reaches the post hook when the pre hook could not wrap it (VS Code's run_in_terminal, a missing shell). Commit 89bd7152 let every such command with a matching filter be compressed there, which returned before the build, monitoring, cat and curl caches below it ran: a repeat `pytest` lost its recall hint and a `cargo build` was rewritten instead of cached. Compression is now limited to test runners and `git diff`, and a compressed test run keeps its recall mapping.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getBashOutput } from '../src/bash_output_cache.js'
import type { HookEvent } from '../src/hook_registry.js'
import { bashRecallKey } from '../src/hooks_bash_commands.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { getBashOutputId } from '../src/session.js'
import { makeHookEvent } from './helpers/hook-event.js'

// HAND-DERIVED: the `  Passed <name>` line shape of `dotnet test`'s console logger, the same shape tests/tool_filters_build.test.ts feeds DotnetFilter; 200 lines so the body clears the recall floor and the filter's collapse clears the net-savings gate.
const DOTNET_TEST = Array.from({ length: 200 }, (_, i) => `  Passed Service.Tests.Case_${i} [1 ms]`).join('\n') + '\nTest Run Successful.\nTotal tests: 200\n     Passed: 200\n'
// HAND-DERIVED: cargo's `   Compiling <crate> v<version>` progress lines, which CargoFilter collapses, so the pre-fix branch rewrote this build instead of caching it.
const CARGO_BUILD = Array.from({ length: 200 }, (_, i) => `   Compiling crate-part${i} v0.1.${i}`).join('\n') + '\n    Finished dev [unoptimized + debuginfo] target(s) in 9.10s\n'

let savedHarness: string | undefined

beforeEach(() => {
  savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
})

afterEach(() => {
  if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
})

function postEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'unwrapped-test-runner',
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  })
}

describe('post-hook compression of unwrapped commands', () => {
  it('compresses an unwrapped dotnet test run and keeps its recall mapping', async () => {
    const cmd = 'dotnet test'
    const result = await postBashHandler(postEvent(cmd, DOTNET_TEST))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType !== 'rewriteOutput') return
    expect(result.updatedOutput).toContain('Test Run Successful')
    expect(result.updatedOutput).not.toContain('Case_0 [1 ms]')
    const id = getBashOutputId(bashRecallKey(cmd, null))
    expect(id).not.toBeNull()
    expect(result.updatedOutput).toContain(`bash-output ${id!} --full`)
    expect(getBashOutput(id!)?.output).toBe(DOTNET_TEST)
  })

  it('leaves an unwrapped cargo build to the build cache instead of rewriting it', async () => {
    const cmd = 'cargo build'
    const result = await postBashHandler(postEvent(cmd, CARGO_BUILD))
    expect(result.hookType).not.toBe('rewriteOutput')
    const id = getBashOutputId(bashRecallKey(cmd, null))
    expect(id).not.toBeNull()
    expect(getBashOutput(id!)?.output).toBe(CARGO_BUILD)
  })
})
