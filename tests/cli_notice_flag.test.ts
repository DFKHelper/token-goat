/**
 * Batch Q2 — the global `--notice <text>` option lets a rewritten command print a disclosure
 * line itself, as the first line of its own single invocation, instead of a caller composing
 * `echo '...' && <command>` through a shell (see src/bash_structural_index.ts's
 * detectStructuralIndexRewrite, the reason this option exists: Windows PowerShell 5.1 has no
 * `&&` at all, so a two-command chain is not a shape every shell can run). Same `preAction` hook
 * `--cwd` uses (src/cli.ts), so it fires ahead of every command's action handler, guard-wrapped
 * or not -- see tests/cli_cwd_dispatch.test.ts for that same-hook precedent.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let target: string
let originalCwd: string
let stderr: string[]
let stdout: string[]
let stderrSpy: WriteSpy
let stdoutSpy: WriteSpy

beforeEach(() => {
  originalCwd = process.cwd()
  target = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-notice-flag-')))
  stderr = []
  stdout = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
  stdoutSpy = spyOnWrite(process.stdout, stdout)
})

afterEach(() => {
  stderrSpy.mockRestore()
  stdoutSpy.mockRestore()
  process.chdir(originalCwd)
  closeAllDbs()
  fs.rmSync(target, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<number | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('--notice prints one line ahead of the command it decorates', () => {
  it('prints the notice text as the first line of stdout, then the command runs normally', async () => {
    process.chdir(target)
    const code = await runCli(['--notice', '[token-goat: rewrote this]', 'config', 'get', 'compact_assist.max_manifest_tokens'])
    expect(code, stderr.join('')).toBe(0)
    const lines = stdout.join('').split('\n').filter((l) => l !== '')
    expect(lines[0]).toBe('[token-goat: rewrote this]')
    expect(lines.length).toBeGreaterThan(1)
  })

  it('omitting --notice prints only the command\'s own output', async () => {
    process.chdir(target)
    const code = await runCli(['config', 'get', 'compact_assist.max_manifest_tokens'])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).not.toContain('token-goat: rewrote')
  })
})
