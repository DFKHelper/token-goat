// A global npm install on Windows puts a `.cmd` shim on PATH, and both doctor's install check and the `claude --version` probe behind exec-form hook detection ran it as `cmd.exe /d /s /c <path> --version`, one argument each, which Node quotes when the path has a space. `/s /c` strips the first and last quote on the line, the two around the path, so a shim in a directory with a space in its path, as npm's global directory is under a Windows account name with a space, ran as the path up to the space and failed. Provenance: CAPTURE for the failure, `'C:\...\sp' is not recognized as an internal or external command` with exit 1, printed by a real cmd.exe on Windows 11 under Node 24.12 for a shim in a directory named `sp ace`; the shims here are HAND-DERIVED one-line batch files, and every run below goes through a real cmd.exe.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkInstall } from '../src/cli_doctor.js'
import { spawnResolvedSync } from '../src/process_util.js'

const SAVED = ['PATH', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const
let saved: Record<string, string | undefined>
let dir: string

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg shim '))
  process.env['PATH'] = dir
  delete process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS']
})

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function shim(name: string, body: string): string {
  const file = path.join(dir, `${name}.cmd`)
  fs.writeFileSync(file, `@echo off\r\n${body}\r\n`)
  return file
}

describe.skipIf(process.platform !== 'win32')('a .cmd shim in a PATH directory whose path has a space', () => {
  it('doctor reports the version the installed shim prints', () => {
    shim('token-goat', 'echo 9.8.7')
    expect(checkInstall()).toEqual({ name: 'Installation', status: 'ok', message: '9.8.7' })
  })

  it('install detects a claude new enough for exec-form hooks', async () => {
    shim('claude', 'echo 2.1.276 (Claude Code)')
    // A fresh module, so the answer comes from this PATH and not one another test cached.
    vi.resetModules()
    const { claudeExecFormHooksSupported } = await import('../src/install.js')
    expect(claudeExecFormHooksSupported()).toBe(true)
  })

  // `token-goat ask` hands its backend a temp-file path, which has a space whenever the account name does, so the words after the shim must arrive as they were sent.
  it('hands every argument to the shim unchanged', () => {
    fs.writeFileSync(path.join(dir, 'echoargs.js'), 'for (const a of process.argv.slice(2)) console.log(JSON.stringify(a))\n')
    const file = shim('echoargs', `"${process.execPath}" "%~dp0echoargs.js" %*`)
    const args = ['--output-last-message', path.join(dir, 'out file.txt'), 'with space', '%PATH%', 'a&b', '']
    const res = spawnResolvedSync(file, args, { encoding: 'utf8', timeout: 15000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown)).toEqual(args)
  })
})
