/** The Claude Code shim backgrounds a hook whose handler always answers pass, by printing `{"async":true}` as its first stdout line before the in-process/spawn round trip runs. The eligible population is Edit/Write/MultiEdit/NotebookEdit outside the markdown family (see postEditHandlerInner in hooks_edit.ts, which answers with real context only for md/mdx/ markdown/rst -- covered directly by tests/hooks_edit.test.ts) and every subagent_stop call (subagentStopHandler in hooks_session.ts returns passOutput() on every branch -- covered directly by tests/hooks_session.test.ts). A Bash post_tool_use call with a result under 200 bytes also qualifies: postBashHandler emits something on only 0.18% of such calls measured, and this branch backgrounds rather than skips, since resolvePendingHintsForEvent still needs to run. These tests exercise the shim's own classification, run as a real subprocess exactly as the harness invokes it, not the handlers it defers to. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { extractTgSurgicalRead } from '../../src/bash_extractors.js'
import { isAsyncDetachEligible } from '../../src/hook_adapters.js'
import { resolveBashCall } from '../../src/hooks_bash_commands.js'
import { BUNDLE } from '../helpers/bundle.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // Ignore transient file lock on Windows temp cleanup
      }
    }
  }
})

// The entry is passed as every installed hook passes it. Without one the shim falls back to whatever `token-goat` is on PATH, so these ran the machine's global install: an older one answered unparseable stdin with its own output and failed them, and a current one passed them for a reason that has nothing to do with this checkout.
function runShim(eventName: string, stdin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-async-'))
  tempDirs.push(dir)
  const scriptPath = join(dir, 'shim.js')
  writeFileSync(scriptPath, CLAUDECODE_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName, BUNDLE], {
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

  // HAND-DERIVED: each command is a token-goat surgical read in one spelling (bare, alias, cd prefix, env prefix, node entry); the expectation follows from the shim's own rule that a read's ledger update must land before the next call.
  it.each([
    'token-goat read src/a.ts@1-3',
    'tg section README.md::Intro',
    'cd /p && token-goat symbol foo',
    'TOKEN_GOAT_HOME=/h token-goat read f',
    'node /x/dist/token-goat.mjs read f@1-2',
    'export A=1; token-goat read f@1-5',
    'export TOKEN_GOAT_BASH_COMPRESS=0; token-goat read f@1-50',
    'export A=1 B="x y" && cd /p && token-goat section f::Intro',
    'cd /p && export A=1; tg read f@1-5',
    '(cd x && token-goat read f)',
    '( export A=1; token-goat read f@1-5 )',
    'env -i token-goat read f@1-3',
    'env FOO=1 token-goat read f@1-3',
    'env -u X token-goat read f@1-3',
    'env --unset=X token-goat read f@1-3',
    'FOO=1 env -u X BAR=2 tg section README.md::Intro',
  ])('never backgrounds the short result of %s, whose ledger update must land before the next call', (command) => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'x'.repeat(50) } }))
    expect(stdout).not.toContain('"async":true')
  })

  // HAND-DERIVED: commands that merely mention or sit beside a read, so the shim's surgical-read rule does not apply.
  it.each(['echo token-goat read f', 'token-goat outline f', 'git status', 'export A=1; git status', 'export A=1; echo token-goat read f', '(cd x && git status)'])('still backgrounds the short result of %s', (command) => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'x'.repeat(50) } }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })

  it('never backgrounds a Bash call with no tool_response at all', () => {
    const stdout = runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash' }))
    expect(stdout.split('\n')[0]).toBe('{"async":true}')
  })
})

describe('the in-process copy of the ledger-read rule agrees with the shim', () => {
  // HAND-DERIVED: the same commands as the shim cases above, asked of src/hook_adapters.ts directly.
  const eligible = (command: string): boolean => isAsyncDetachEligible('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'x'.repeat(50) } }))
  it.each(['export A=1; token-goat read f@1-5', 'export TOKEN_GOAT_BASH_COMPRESS=0; token-goat read f@1-50', 'export A=1 B="x y" && cd /p && token-goat section f::Intro', 'cd /p && export A=1; tg read f@1-5', '(cd x && token-goat read f)', '( export A=1; token-goat read f@1-5 )'])('treats %s as a ledger read, not eligible', (command) => {
    expect(eligible(command)).toBe(false)
  })

  it.each(['export A=1; git status', 'export A=1; echo token-goat read f', '(cd x && git status)'])('treats %s as eligible', (command) => {
    expect(eligible(command)).toBe(true)
  })
})

describe('every read the ledger records is one the no-detach rule matches, in both copies', () => {
  const eligible = (command: string): boolean => isAsyncDetachEligible('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'x'.repeat(50) } }))
  const shimDetaches = (command: string): boolean => runShim('post_tool_use', JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'x'.repeat(50) } })).startsWith('{"async":true}')
  // The ledger side is what the post hook does with the command: resolveBashCall peels the prefix, extractTgSurgicalRead decides whether anything is recorded.
  const recorded = (command: string): boolean => extractTgSurgicalRead(resolveBashCall(command, '/proj').cmd, '/proj') !== null

  // HAND-DERIVED: the expected column follows from env(1): `-i`, `-u NAME` and NAME=value change only the environment, while `-C DIR` and `--chdir=DIR` run the read in another directory, so the ledger cannot place the file and records nothing.
  const SHAPES: Array<[string, boolean]> = [
    ['token-goat read f@1-3', true],
    ['tg section README.md::Intro', true],
    ['FOO=1 token-goat read f@1-3', true],
    ['env token-goat read f@1-3', true],
    ['env -i token-goat read f@1-3', true],
    ['env FOO=1 token-goat read f@1-3', true],
    ['env -u X token-goat read f@1-3', true],
    ['env --unset X token-goat read f@1-3', true],
    ['env --unset=X token-goat read f@1-3', true],
    ['env -i -u X FOO=1 BAR=2 token-goat read f@1-3', true],
    ['FOO=1 env -u X token-goat read f@1-3', true],
    ['cd /p && env -u X token-goat read f@1-3', true],
    ['export A=1; env FOO=1 tg read f@1-3', true],
    ['(cd /p && env -i token-goat read f@1-3)', true],
    ['cd missing && token-goat read f@1-3', true],
    ['cd - && token-goat read f@1-3', true],
    // HAND-DERIVED: XDG_DATA_HOME moves where the index is looked up and PYTHONPATH what a python-based tool imports, so a read under either is not the bare read and records nothing.
    ['XDG_DATA_HOME=/x token-goat read f@1-3', false],
    ['PYTHONPATH=/x token-goat read f@1-3', false],
    ['env XDG_DATA_HOME=/x token-goat read f@1-3', false],
    ['env -i PYTHONPATH=/x token-goat read f@1-3', false],
    ['env -C /other token-goat read f@1-3', false],
    ['env --chdir=/other token-goat read f@1-3', false],
    ['env --chdir /other token-goat read f@1-3', false],
    ['env --ch=/other token-goat read f@1-3', false],
    ['env --chd /other token-goat read f@1-3', false],
    ['env --c=/other token-goat read f@1-3', false],
    ['env -C /other FOO=1 token-goat read f@1-3', false],
    ['env -iC /other token-goat read f@1-3', false],
    ['pushd /other && token-goat read f@1-3', false],
    ['echo token-goat read f', false],
  ]

  it.each(SHAPES)('%s: the ledger records it = %s', (command, expected) => {
    expect(recorded(command)).toBe(expected)
  })

  it.each(SHAPES.filter(([, isRecorded]) => isRecorded))('the in-process rule does not detach %s', (command) => {
    expect(eligible(command)).toBe(false)
  })

  it.each(SHAPES.filter(([, isRecorded]) => isRecorded).map(([command]) => command))('the shim does not detach %s', (command) => {
    expect(shimDetaches(command)).toBe(false)
  })

  it.each(['echo token-goat read f', 'env -i git status', 'env FOO=1 echo token-goat read f'])('both copies still detach %s', (command) => {
    expect(eligible(command)).toBe(true)
    expect(shimDetaches(command)).toBe(true)
  })
})
