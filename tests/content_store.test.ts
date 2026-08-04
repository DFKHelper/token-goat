import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearModuleCaches } from '../src/reset.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
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

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  home = fs.mkdtempSync(path.join(process.cwd(), '.tg-content-test-'))
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = path.join(home, 'AppData', 'Local')
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n')
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
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
    const otherProject = fs.mkdtempSync(path.join(process.cwd(), '.tg-content-other-project-'))
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
