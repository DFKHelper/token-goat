/**
 * The Claude Code shim backgrounds a hook whose handler always answers pass, by printing
 * `{"async":true}` as its first stdout line before the in-process/spawn round trip runs. The
 * eligible population is Edit/Write/MultiEdit/NotebookEdit outside the markdown family (see
 * postEditHandlerInner in hooks_edit.ts, which answers with real context only for md/mdx/
 * markdown/rst -- covered directly by tests/hooks_edit.test.ts) and every subagent_stop call
 * (subagentStopHandler in hooks_session.ts returns passOutput() on every branch -- covered
 * directly by tests/hooks_session.test.ts). A Bash post_tool_use call with a result under 200
 * bytes also qualifies: postBashHandler emits something on only 0.18% of such calls measured, and
 * this branch backgrounds rather than skips, since resolvePendingHintsForEvent still needs to run.
 * These tests exercise the shim's own classification, run as a real subprocess exactly as the
 * harness invokes it, not the handlers it defers to.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function runShim(eventName: string, stdin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-async-'))
  tempDirs.push(dir)
  const scriptPath = join(dir, 'shim.js')
  writeFileSync(scriptPath, CLAUDECODE_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd: dir,
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  })
  return res.stdout ?? ''
}

describe('Claude Code shim async-detach classification', () => {
  it('backgrounds every subagent_stop call', () => {
    const stdout = runShim('subagent_stop', '{}')
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })

  it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])('backgrounds a %s post_tool_use call on a non-markdown file', (toolName) => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: toolName, tool_input: { file_path: 'src/foo.ts' } }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })

  it('backgrounds a NotebookEdit call keyed on notebook_path rather than file_path', () => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'nb.ipynb' } }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })

  it.each(['.md', '.mdx', '.markdown', '.rst'])('never backgrounds an Edit whose file has a %s extension', (ext) => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: `README${ext}` } }))
    expect(stdout).not.toContain('"async":true')
  })

  it('never backgrounds a Bash call whose result is large', () => {
    const stdout = runShim(
      'post_tool_use',
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x'.repeat(5000) } }),
    )
    expect(stdout).not.toContain('"async":true')
  })

  it('never backgrounds a pre_tool_use call', () => {
    const stdout = runShim('pre_tool_use', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/foo.ts' } }))
    expect(stdout).not.toContain('"async":true')
  })

  it('fails closed to a non-async classification on unparseable stdin, rather than throwing', () => {
    const stdout = runShim('post_tool_use', 'not json at all')
    expect(stdout).not.toContain('"async":true')
    expect(stdout.trim()).toBe('{}')
  })

  it('backgrounds a Bash call whose tool_response is a string under 200 bytes', () => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_response: 'x'.repeat(50) }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })

  it('backgrounds a Bash call whose tool_response.stdout is under 200 bytes', () => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(199) } }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })

  it('never backgrounds a Bash call whose tool_response.stdout is 200 bytes or more', () => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(200) } }))
    expect(stdout).not.toContain('"async":true')
  })

  it('trusts a numeric persistedOutputSize over reading the response text', () => {
    const stdout = runShim(
      'post_tool_use',
      JSON.stringify({ tool_name: 'Bash', tool_response: { persistedOutputPath: '/x', persistedOutputSize: 5000 } }),
    )
    expect(stdout).not.toContain('"async":true')
  })

  it('never backgrounds a Bash call with no tool_response at all', () => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash' }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })
})
