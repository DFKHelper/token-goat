// The branch hint, the subagent no-changes check and the compaction git bonus all bound their git call by `hints.git_hint_max_ms`, and every test of that wiring mocked runGit, so none ran git under the shipped default. That default was 50 ms, which a real git call on Windows (57-184 ms measured) never meets: the hint was dead there and each kill left the launcher's git child running in the caller's cwd. This drives the real handler, real git and the default config.
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { gitRepoWithCommit } from './helpers/git-repo.js'
import { tempConfigPath } from './helpers/temp-config.js'
import type { HookEvent } from '../src/hook_registry.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

const _testConfigPath = tempConfigPath('tg-git-hint-default-timeout.toml')

import { userPromptSubmitHandler } from '../src/hooks_session.js'

describe('hints.git_hint_max_ms default', () => {
  it('lets the real branch-hint git call finish, so the hint reaches the prompt', async () => {
    const repo = gitRepoWithCommit()
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    const prompt = (): HookEvent => ({
      eventName: 'user_prompt_submit',
      toolName: undefined,
      toolInput: {},
      sessionId: `git-hint-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      agentId: undefined,
      raw: { prompt: 'this is a long enough prompt to pass the length check', cwd: repo },
    })

    // A loaded full suite can hold one git call past the budget, which drops the hint for that prompt only, so a missing hint is retried twice on a fresh session. A budget too small for git on this machine still fails all three: 20 ms does here.
    let result = await userPromptSubmitHandler(prompt())
    for (let attempt = 1; attempt < 3 && result.hookType !== 'context'; attempt++) {
      result = await userPromptSubmitHandler(prompt())
    }

    expect(result.hookType).toBe('context')
    expect((result as { context: string }).context).toContain(`branch: ${branch}`)
  })
})
