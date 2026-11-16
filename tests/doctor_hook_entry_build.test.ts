import type * as ChildProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkHookEntryBuild } from '../src/cli_doctor_build.js'

const spawnCalls = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: (file: string) => {
    spawnCalls.push(file)
    return { pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null, error: undefined }
  },
}))

let TMP: string
let savedPath: string | undefined

function writeBundle(name: string, text: string): string {
  const file = path.join(TMP, name, 'dist', 'token-goat.mjs')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

/** The wired hook words the doctor passes in: the shim command, then the bundle it runs. */
function wiredRunning(bundle: string): string[][] {
  return [['node', path.join(TMP, 'shim.cjs'), 'pre_tool_use', bundle]]
}

/** A PATH dir with npm's `token-goat` launcher; its installed bundle holds `text`. */
function npmLauncherDir(text: string): string {
  const dir = path.join(TMP, 'npm-bin')
  fs.mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'token-goat.CMD'), '@echo off\r\n')
    const bundle = path.join(dir, 'node_modules', 'token-goat', 'dist', 'token-goat.mjs')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    fs.writeFileSync(bundle, text)
  } else {
    const bundle = path.join(TMP, 'lib', 'token-goat', 'dist', 'token-goat.mjs')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    fs.writeFileSync(bundle, text)
    fs.symlinkSync(bundle, path.join(dir, 'token-goat'))
  }
  return dir
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-build-'))
  savedPath = process.env['PATH']
  spawnCalls.length = 0
})

afterEach(() => {
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('checkHookEntryBuild', () => {
  it('returns null when no wired hook runs a token-goat bundle', () => {
    expect(checkHookEntryBuild([['node', 'C:/x/shim.cjs', 'pre_tool_use']], () => null)).toBeNull()
  })

  it('is ok when the hook bundle and the PATH CLI bundle are the same bytes', () => {
    const entry = writeBundle('same-a', 'same build\n')
    const cli = writeBundle('same-b', 'same build\n')
    const row = checkHookEntryBuild(wiredRunning(entry), () => cli)
    expect(row?.status).toBe('ok')
  })

  it('warns with the mismatch text when the bundles differ', () => {
    const entry = writeBundle('checkout', 'checkout build\n')
    const cli = writeBundle('global', 'global build\n')
    const row = checkHookEntryBuild(wiredRunning(entry), () => cli)
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('hook entry build != PATH CLI build')
    expect(row?.message).toContain('token-goat doctor --fix')
  })

  it('warns when the PATH CLI build cannot be found', () => {
    const entry = writeBundle('no-cli', 'build\n')
    const row = checkHookEntryBuild(wiredRunning(entry), () => null)
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('cannot find the PATH CLI build')
  })

  it('warns when the hook bundle no longer exists', () => {
    const missing = path.join(TMP, 'gone', 'dist', 'token-goat.mjs')
    const row = checkHookEntryBuild(wiredRunning(missing), () => null)
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('does not exist')
  })

  it('warns instead of throwing when the hook bundle path is a directory', () => {
    const dirEntry = path.join(TMP, 'entry-is-dir', 'dist', 'token-goat.mjs')
    fs.mkdirSync(dirEntry, { recursive: true })
    const cli = writeBundle('cli-for-dir-entry', 'build\n')
    const row = checkHookEntryBuild(wiredRunning(dirEntry), () => cli)
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('cannot read hook entry')
  })

  it('warns instead of throwing when the PATH CLI build path is a directory', () => {
    const entry = writeBundle('entry-for-dir-cli', 'build\n')
    const dirCli = path.join(TMP, 'cli-is-dir', 'dist', 'token-goat.mjs')
    fs.mkdirSync(dirCli, { recursive: true })
    const row = checkHookEntryBuild(wiredRunning(entry), () => dirCli)
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('cannot read the PATH CLI build')
  })

  it('reads the PATH launcher without spawning npm', () => {
    const entry = writeBundle('spawn-free-entry', 'same build\n')
    process.env['PATH'] = npmLauncherDir('same build\n')
    const row = checkHookEntryBuild(wiredRunning(entry))
    expect(spawnCalls).toEqual([])
    expect(row?.status).toBe('ok')
  })

  it('compares against the bundle the PATH launcher runs', () => {
    const entry = writeBundle('path-entry', 'checkout build\n')
    process.env['PATH'] = npmLauncherDir('global build\n')
    const row = checkHookEntryBuild(wiredRunning(entry))
    expect(spawnCalls).toEqual([])
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('hook entry build != PATH CLI build')
  })

  it('warns unknown when no token-goat launcher is on PATH', () => {
    const entry = writeBundle('no-launcher', 'build\n')
    process.env['PATH'] = path.join(TMP, 'empty-bin')
    const row = checkHookEntryBuild(wiredRunning(entry))
    expect(spawnCalls).toEqual([])
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('unknown')
  })
})
