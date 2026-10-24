/** Claude Code's PowerShell tool runs the same shell hooks as its Bash tool, through the real registry. PROVENANCE: the tool_input {command, description} is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks.md (PowerShell section: "The fields match the Bash tool, with the command string in `command`"); the tool_response shape is UNVERIFIED (that page does not document it) and only reuses the Bash one; every command value is HAND-DERIVED. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gitRepoWithCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { tempConfigPath } from './helpers/temp-config.js'

// dataDir() points at a per-file temp dir so the queue the hook writes never touches a real one.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, dataDir: () => _testDataDir }
})

const _testConfigPath = tempConfigPath('tg-shell-ps-tool-config-test.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-shell-ps-tool-data-'))

// Side-effect import: registers every hook handler, as the shipping relay does.
import '../src/relay.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { handlersFor, runHook, type HookEvent } from '../src/hook_registry.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { resolveIndexPath } from '../src/paths.js'
import { foldPath } from '../src/util.js'

function powerShellCall(command: string, cwd: string): HookEvent {
  const toolInput = { command, description: 'run' }
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'PowerShell', toolInput, sessionId: 'shell-ps-tool-session', raw: { tool_name: 'PowerShell', tool_input: toolInput, tool_response: { stdout: 'done', stderr: '', exit_code: 0 }, cwd } })
}

const dirs: string[] = []
beforeEach(() => clearDirtyQueue())
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Claude Code's PowerShell tool reaches the same shell hooks as Bash", () => {
  it('queues the file a Set-Content wrote', async () => {
    const dir = gitRepoWithCommit()
    dirs.push(dir)
    await runHook(powerShellCall("Set-Content -Path a.txt -Value 'x'", dir))
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('queues nothing for a Get-Content read', async () => {
    const dir = gitRepoWithCommit()
    dirs.push(dir)
    await runHook(powerShellCall('Get-Content a.txt', dir))
    expect(getDirtyPaths()).toEqual([])
  })

  it('registers the pre handlers Bash has and the post handler Bash uses', () => {
    expect(handlersFor('pre_tool_use', 'PowerShell'), 'pre_tool_use handlers for PowerShell').toHaveLength(handlersFor('pre_tool_use', 'Bash').length)
    expect(handlersFor('post_tool_use', 'PowerShell'), 'post_tool_use handlers for PowerShell').toContain(postBashHandler)
  })
})
