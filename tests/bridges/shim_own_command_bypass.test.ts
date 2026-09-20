/**
 * The Claude Code shim skips the in-process/spawn round trip entirely for a pre_tool_use Bash
 * call that is token-goat's own CLI, because none of preBashHandlerInner's extractors match one
 * (see isOwnTokenGoatCommand's docstring in shim_common.ts). These tests prove the bypass by
 * checking whether a fake baked entry was actually invoked, not just by reading stdout: a
 * `{}` response is also what a normal call produces when it fails to resolve a real binary, so
 * stdout alone cannot distinguish "bypassed" from "fell through and failed".
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function mkIsolated(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-bypass-'))
  tempDirs.push(dir)
  return dir
}

/** A fake baked entry that records that it was invoked and answers with real hook output, so a test can tell a bypass (entry never runs, stdout is bare `{}`) apart from a fall-through that reached the real dispatch. */
function writeFakeEntry(cwd: string): { entryPath: string; invokedPath: string } {
  const entryPath = join(cwd, 'fake-entry.js')
  const invokedPath = join(cwd, 'invoked.txt')
  writeFileSync(
    entryPath,
    `require('fs').writeFileSync(${JSON.stringify(invokedPath)}, 'yes')\nprocess.stdout.write('{"hookSpecificOutput":{"additionalContext":"reached real entry"}}')\n`,
    'utf8',
  )
  return { entryPath, invokedPath }
}

function runShim(command: string, entryPath: string, cwd: string): { stdout: string; invoked: boolean } {
  const scriptPath = join(cwd, 'shim.js')
  writeFileSync(scriptPath, CLAUDECODE_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
    cwd,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    timeout: 15000,
  })
  return { stdout: res.stdout ?? '', invoked: existsSync(join(cwd, 'invoked.txt')) }
}

describe('Claude Code shim own-command bypass', () => {
  it.each([
    'token-goat read "src/foo.ts::bar"',
    'node /path/to/token-goat.mjs read foo',
    'TOKEN_GOAT_HOME=/x token-goat read foo',
    'cd /some/dir && token-goat read foo',
  ])('never invokes the entry for %s', (command) => {
    const cwd = mkIsolated()
    const { entryPath, invokedPath } = writeFakeEntry(cwd)
    const { stdout, invoked } = runShim(command, entryPath, cwd)
    expect(invoked, 'entry must not run').toBe(false)
    expect(existsSync(invokedPath)).toBe(false)
    expect(stdout).toBe('{}')
  })

  it.each([
    ['a compound command that merely contains a token-goat call among others', 'token-goat read foo && rm -rf /'],
    ['an unrelated Bash command', 'ls -la'],
    ['a command that only mentions token-goat inside its own text', 'echo "run token-goat later"'],
  ])('still invokes the entry for %s', (_label, command) => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd)
    const { stdout, invoked } = runShim(command, entryPath, cwd)
    expect(invoked, 'entry must run').toBe(true)
    expect(stdout).toContain('reached real entry')
  })

  it('does not bypass on a non-Bash tool', () => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd)
    const scriptPath = join(cwd, 'shim.js')
    writeFileSync(scriptPath, CLAUDECODE_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
      cwd,
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'token-goat.ts' } }),
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(existsSync(join(cwd, 'invoked.txt'))).toBe(true)
    expect(res.stdout).toContain('reached real entry')
  })

  it('does not bypass a post_tool_use event even for an own-command call', () => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd)
    const scriptPath = join(cwd, 'shim.js')
    writeFileSync(scriptPath, CLAUDECODE_HOOK_SCRIPT, 'utf8')
    spawnSync(process.execPath, [scriptPath, 'post_tool_use', entryPath], {
      cwd,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'token-goat read foo' } }),
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(existsSync(join(cwd, 'invoked.txt'))).toBe(true)
  })

  it('falls through to normal handling on unparseable stdin, rather than throwing', () => {
    const cwd = mkIsolated()
    const { entryPath } = writeFakeEntry(cwd)
    const scriptPath = join(cwd, 'shim.js')
    writeFileSync(scriptPath, CLAUDECODE_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
      cwd,
      input: 'not json at all',
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(res.status).toBe(0)
    expect(existsSync(join(cwd, 'invoked.txt'))).toBe(true)
  })
})
