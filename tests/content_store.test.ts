import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearModuleCaches } from '../src/reset.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import {
  compressText,
  createHandoff,
  resolveHandoff,
  retrieveText,
  CONTENT_MAX_INPUT_CHARS,
} from '../src/content_store.js'
import { summarize } from '../src/stats.js'

let home: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-content-test-'))
  process.env['TOKEN_GOAT_HOME'] = home
  // recordStat writes through getGlobalDb() (which uses dataDir(), driven by these env vars) while summarize(..., home) reads through getGlobalDb(home) (which uses dataDirForHome(home)). The two agree only if the env root is the exact parent of dataDirForHome's per-platform layout -- `<home>/AppData/Local` happens to satisfy that on win32 and nowhere else, which is why hardcoding it passed on Windows and left every stat assertion at zero on macOS and Linux. Derive the root from dataDirForHome so the two paths agree on every platform, and pin both vars because dataDir() reads LOCALAPPDATA on win32 and XDG_DATA_HOME elsewhere.
  const dataRoot = dataDirForHome(home)
  const envRoot =
    process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
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

describe('generic content compression', () => {
  it('round-trips arbitrary text with a stable opaque ID and recovery metadata', () => {
    const text = 'repeat '.repeat(500)
    const first = compressText(text)
    const second = compressText(text)
    expect(first.id).toBe(second.id)
    expect(first.recovery).toContain(first.id)
    expect(retrieveText(first.id)).toBe(text)
  })

  it('enforces the bounded input size', () => {
    expect(() => compressText('x'.repeat(CONTENT_MAX_INPUT_CHARS + 1))).toThrow(/safety limit/)
  })
})

describe('project-local handoffs and telemetry', () => {
  it('resolves compactly by default and fully on request', () => {
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-content-other-project-'))
    fs.writeFileSync(path.join(otherProject, 'package.json'), '{}\n')
    const created = createHandoff('review-notes', 'handoff '.repeat(100), home)
    const compact = resolveHandoff('review-notes', { projectRoot: home })
    expect(created.contentId).toMatch(/^tg_[0-9a-f]{16}$/)
    expect(typeof compact).toBe('object')
    expect(resolveHandoff('review-notes', { projectRoot: home, full: true })).toBe('handoff '.repeat(100))
    expect(resolveHandoff('review-notes', { projectRoot: path.join(home, 'nested') })).not.toBeNull()
    expect(resolveHandoff('review-notes', { projectRoot: otherProject })).toBeNull()

    const summary = summarize(0, undefined, home)
    expect(summary.by_kind['content_compress']?.events).toBeGreaterThan(0)
    expect(summary.by_kind['handoff_create']?.events).toBe(1)
    expect(summary.by_kind['handoff_resolve']?.events).toBe(3)
    fs.rmSync(otherProject, { recursive: true, force: true })
  })
})
