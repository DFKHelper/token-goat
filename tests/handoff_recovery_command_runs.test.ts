// The `recovery` field `handoff-create` prints must be a command that works when run as written: a handoff name may start with a hyphen (the name pattern allows it), and without `--` the resolve command read such a name as an option and failed.

// CAPTURE-DERIVED: the command line under test is the `recovery` field a real built bundle printed for a real handoff, run back through the same bundle; the name `-dash` is invented to begin with a hyphen, which /^[A-Za-z0-9._-]{1,128}$/ in content_store.ts accepts.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dataDirForHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import { BUNDLE } from './helpers/bundle.js'

let home: string
let envRoot: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-recovery-'))
  process.env['TOKEN_GOAT_HOME'] = home
  const dataRoot = dataDirForHome(home)
  envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n')
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

function runIsolated(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd: home })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('the handoff recovery command', () => {
  it('ends the options before a name that starts with a hyphen, and resolves when run as printed', () => {
    const created = runIsolated(['handoff-create', '--', '-dash', 'the decision was to keep the cache'])
    expect(created.status, created.stderr).toBe(0)
    const recovery = (JSON.parse(created.stdout) as { recovery: string }).recovery
    expect(recovery).toBe('token-goat handoff-resolve -- "-dash"')

    const resolved = runIsolated(['handoff-resolve', '--full', '--', '-dash'])
    expect(resolved.status, resolved.stderr).toBe(0)
    expect(resolved.stdout).toContain('the decision was to keep the cache')
  })
})
