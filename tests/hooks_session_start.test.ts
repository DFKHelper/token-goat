import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Redirect configPath()/globalDbPath() to per-test-file temp locations so config-gating and
// indexed-project tests are deterministic -- mirrors tests/hooks_compact.test.ts's config mock.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    globalDbPath: () => _testDbPath,
  }
})

const _testConfigPath = path.join(os.tmpdir(), `tg-hooks-session-start-config-${process.pid}.toml`)
const _testDbPath = path.join(os.tmpdir(), `tg-hooks-session-start-db-${process.pid}.sqlite`)

import type { HookEvent } from '../src/hook_registry.js'
import { sessionStartHandler } from '../src/hooks_session_start.js'
import * as cliDoctor from '../src/cli_doctor.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'

function makeEvent(cwd?: string): HookEvent {
  return {
    eventName: 'session_start',
    toolName: undefined,
    toolInput: {},
    sessionId: 'test-session',
    agentId: undefined,
    raw: cwd !== undefined ? { cwd } : {},
  }
}

beforeEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
  for (const p of [_testConfigPath, _testDbPath]) {
    try {
      fs.rmSync(p)
    } catch {
      // absent is fine
    }
  }
})

afterEach(() => {
  for (const p of [_testConfigPath, _testDbPath]) {
    try {
      fs.rmSync(p)
    } catch {
      // best-effort cleanup
    }
  }
})

describe('sessionStartHandler', () => {
  it('emits a project-aware reminder naming the indexed symbol count when the cwd is indexed', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-start-proj-'))
    try {
      const forwardSlashDir = normalizePath(projectDir)
      const db = getDb(_testDbPath)
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`${forwardSlashDir}/a.ts`, 'foo', 'function', 1, 2, '', '')
      db.prepare(
        'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`${forwardSlashDir}/b.ts`, 'bar', 'function', 1, 2, '', '')

      const result = sessionStartHandler(makeEvent(projectDir))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('indexed (2 symbols)')
        expect(result.context).toContain('symbol')
        expect(result.context).toContain('Read/Grep tool call')
        expect(result.context).toContain('shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls`')
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('degrades to a short generic reminder when the cwd is not indexed', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-start-unindexed-'))
    try {
      getDb(_testDbPath) // create an empty db so countSymbols has something to query against
      const result = sessionStartHandler(makeEvent(projectDir))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('token-goat index .')
        expect(result.context).not.toContain('is indexed')
        expect(result.context).toContain('Read/Grep tools')
        expect(result.context).toContain('shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls`')
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('degrades to the generic reminder when no cwd is present on the event', () => {
    const result = sessionStartHandler(makeEvent(undefined))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat index .')
      expect(result.context).toContain('Read/Grep tools')
      expect(result.context).toContain('shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls`')
    }
  })

  it('emits nothing (pass) when hints.session_start_reminder is disabled', () => {
    const cfg = defaultConfig()
    cfg.hints.session_start_reminder = false
    saveConfig(cfg)
    invalidateConfigCache()

    const result = sessionStartHandler(makeEvent(undefined))
    expect(result).toEqual({ hookType: 'pass' })
  })

  it('appends a DB-health warning to the context when a stored symbol body exceeds MAX_SYMBOL_BODY_CHARS', () => {
    const db = getDb(_testDbPath)
    const oversized = 'x'.repeat(200 * 1024)
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('/some/generated.js', 'bloated', 'function', 1, 2, oversized, '')

    const result = sessionStartHandler(makeEvent(undefined))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('above the')
      expect(result.context).toContain('reclaim-index')
    }
  })

  it('does not add DB-health noise when no stored symbol body exceeds MAX_SYMBOL_BODY_CHARS', () => {
    const db = getDb(_testDbPath)
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('/some/normal.js', 'small', 'function', 1, 2, 'return 1', '')

    const result = sessionStartHandler(makeEvent(undefined))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).not.toContain('reclaim-index')
    }
  })

  // Regression: the assertion above (`.not.toContain('reclaim-index')`) is tautological on its
  // own -- the base reminder never contains that substring, so it still passes even if the
  // entire health-check block (the try/catch wrapping checkSymbolBodySize) were deleted from the
  // hook outright. This test proves the block actually runs by spying on checkSymbolBodySize
  // itself: deleting the block makes this spy assertion fail regardless of DB content, closing
  // the gap the negative-content assertion above cannot cover on its own.
  it('actually invokes checkSymbolBodySize while building context', () => {
    const spy = vi.spyOn(cliDoctor, 'checkSymbolBodySize')
    const result = sessionStartHandler(makeEvent(undefined))
    expect(spy).toHaveBeenCalledWith(_testDbPath)
    expect(result.hookType).toBe('context')
    spy.mockRestore()
  })

  it('fails soft (pass) when the underlying DB lookup throws', () => {
    // Point at a path that can never be a valid sqlite file (a directory), so getDb()/countSymbols()
    // throws inside buildReminder() and the handler's own try/catch must still return cleanly.
    const badDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-start-baddb-'))
    fs.rmSync(_testDbPath, { force: true })
    fs.renameSync(badDbDir, _testDbPath)
    try {
      const result = sessionStartHandler(makeEvent(process.cwd()))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('token-goat index .')
        expect(result.context).toContain('Read/Grep tools')
        expect(result.context).toContain('shell commands like `rg`, `grep`, `fd`, `sed`, `cat`, `find`, and `ls`')
      }
    } finally {
      fs.rmSync(_testDbPath, { recursive: true, force: true })
    }
  })
})
