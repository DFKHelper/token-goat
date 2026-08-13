/**
 * `retrieve` gains the same output filters as bash-output/web-output/mcp-output (--head, --tail,
 * --grep, --max-matches, --section, --full) via the shared `_applyFiltersAndPrint`, so a large
 * stored blob can be recalled a slice at a time instead of taking all of it.
 *
 * The one place `retrieve` must NOT match its siblings: it is the lossless round-trip contract
 * for `compress-text`, and other commands' output literally quotes `recovery: token-goat
 * retrieve <id>` as the way to get the original bytes back. The siblings default to eliding
 * everything past a 30/80 head/tail window when no --head/--tail is given; `retrieve` must not
 * inherit that default, or the recovery contract silently stops being lossless. Any narrowing
 * flag IS an explicit ask, so sibling semantics (elision included) apply once one is given.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { dataDirForHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'

let home: string
let envRoot: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-retrieve-filters-'))
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

/** 200 numbered lines, well past the 30/80 head/tail elision window, so a default-elision regression is caught. */
function bigBlob(): string {
  const lines: string[] = []
  for (let i = 1; i <= 200; i++) lines.push(`line ${i}`)
  return lines.join('\n')
}

function retrieveIdFor(text: string): string {
  const file = path.join(home, 'blob.txt')
  fs.writeFileSync(file, text)
  const r = runIsolated(['compress-text', '--file', file])
  expect(r.status, r.stderr).toBe(0)
  const match = /^id: (\S+)$/m.exec(r.stdout)
  expect(match, `expected an id line in: ${r.stdout}`).not.toBeNull()
  return match![1]
}

describe('retrieve output filters', () => {
  it('bare retrieve <id> returns a large blob byte-identical, with no elision marker', () => {
    const text = bigBlob()
    expect(text.split('\n').length, 'fixture must exceed the default 30+80 head/tail window').toBeGreaterThan(110)
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.replace(/\n$/, '')).toBe(text)
    expect(r.stdout).not.toContain('...(elided)...')
  })

  it('--section extracts just the named section', () => {
    const text = ['# intro', 'intro body', '', '## Details', 'detail line 1', 'detail line 2'].join('\n')
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id, '--section', 'Details'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('detail line 1')
    expect(r.stdout).not.toContain('intro body')
  })

  it('--grep filters to matching lines only', () => {
    const text = bigBlob()
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id, '--grep', 'line 5$'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('line 5\n')
    expect(r.stdout).not.toContain('line 50\n')
    expect(r.stdout).not.toContain('line 1\n')
  })

  it('--head N truncates to the first N lines', () => {
    const text = bigBlob()
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id, '--head', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('line 1\nline 2\nline 3')
  })
})
