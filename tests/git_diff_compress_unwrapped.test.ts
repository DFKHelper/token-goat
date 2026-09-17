import { describe, expect, it } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { postBashHandler } from '../src/hooks_bash.js'
import { compressOutput } from '../src/bash_compress.js'

function makePostBashEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    agentId: undefined,
    raw: {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: output,
    },
  })
}

describe('Unwrapped git diff output compression and lower threshold', () => {
  it('compresses a 50-line git diff from direct/unwrapped invocation', async () => {
    const diffLines = [
      'diff --git a/audit_non_internal_paths.ps1 b/audit_non_internal_paths.ps1',
      'index 1111111..2222222 100644',
      '--- a/audit_non_internal_paths.ps1',
      '+++ b/audit_non_internal_paths.ps1',
      '@@ -10,30 +10,30 @@ function Audit-NonInternalPaths {',
      ...Array.from({ length: 25 }, (_, i) => `-   Write-Host "Old debug line ${i}"`),
      ...Array.from({ length: 25 }, (_, i) => `+   Write-Output "New clean line ${i}"`),
      'diff --git a/AuditNonInternalPaths.Output.Tests.ps1 b/AuditNonInternalPaths.Output.Tests.ps1',
      'index 3333333..4444444 100644',
      '--- a/AuditNonInternalPaths.Output.Tests.ps1',
      '+++ b/AuditNonInternalPaths.Output.Tests.ps1',
      '@@ -1,20 +1,20 @@',
      ...Array.from({ length: 20 }, (_, i) => `+   It "test case ${i}" { $true | Should -Be $true }`),
    ].join('\n')

    const event = makePostBashEvent('git diff', diffLines)
    const result = await postBashHandler(event)

    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toContain('token-goat')
      expect(result.updatedOutput).toContain('git-diff filter')
      expect(result.updatedOutput).toContain('bash-output')
      expect(result.updatedOutput).toContain('--full')
    }
  })

  it('passes through small git diff (< 40 lines) without rewrite', async () => {
    const smallDiff = [
      'diff --git a/README.md b/README.md',
      'index 111..222 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,3 +1,3 @@',
      '-# Old Title',
      '+# New Title',
    ].join('\n')

    const event = makePostBashEvent('git diff', smallDiff)
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('compressOutput runs git diff compression on large single-file diffs', () => {
    const diffLines = [
      'diff --git a/file1.txt b/file1.txt',
      'index 111..222 100644',
      '--- a/file1.txt',
      '+++ b/file1.txt',
      '@@ -1,80 +1,80 @@',
      ...Array.from({ length: 80 }, (_, i) => `+added line ${i}`),
    ].join('\n')

    const compressed = compressOutput(diffLines)
    expect(compressed).toContain('[Git diff:')
    expect(compressed).toContain('more lines in file1.txt')
    expect(compressed.length).toBeLessThan(diffLines.length)
  })

  it('GitDiffFilter truncates hunks with > 25 changed lines', async () => {
    const { GitDiffFilter } = await import('../src/tool_filters/git.js')
    const filter = new GitDiffFilter()
    const hunkLines = [
      'diff --git a/file1.ts b/file1.ts',
      'index 111..222 100644',
      '--- a/file1.ts',
      '+++ b/file1.ts',
      '@@ -1,35 +1,35 @@',
      ...Array.from({ length: 35 }, (_, i) => `+added line ${i}`),
    ].join('\n')

    const res = filter.compress(hunkLines, '', 0, ['git', 'diff'])
    expect(res).toContain('omitted by token-goat')
  })
})
