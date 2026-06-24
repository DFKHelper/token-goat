import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectHarness, getHarnessName } from '../../src/bridges/registry.js'
import { clearModuleCaches } from '../../src/reset.js'

const ENV_KEYS = [
  'TERM_PROGRAM',
  'CLAUDE_CODE_VERSION',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
] as const

describe('harness detection', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    clearModuleCaches()
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    clearModuleCaches()
  })

  describe('detectHarness', () => {
    it('returns claudecode when CLAUDE_CODE_VERSION is set', () => {
      process.env['CLAUDE_CODE_VERSION'] = '1.2.3'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns claudecode when TERM_PROGRAM is claude-code', () => {
      process.env['TERM_PROGRAM'] = 'claude-code'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns codex when CODEX_SESSION_ID is set', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(detectHarness()).toBe('codex')
    })

    it('returns opencode when OPENCODE_SESSION_ID is set', () => {
      process.env['OPENCODE_SESSION_ID'] = 'xyz'
      expect(detectHarness()).toBe('opencode')
    })

    it('returns generic as fallback', () => {
      expect(detectHarness()).toBe('generic')
    })

    it('prefers claudecode over codex when both signals are present', () => {
      process.env['CLAUDE_CODE_VERSION'] = '1.0'
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(detectHarness()).toBe('claudecode')
    })
  })

  describe('getHarnessName caching', () => {
    it('caches the first result across env changes', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(getHarnessName()).toBe('codex')
      delete process.env['CODEX_SESSION_ID']
      // Cached: still codex despite env now being empty.
      expect(getHarnessName()).toBe('codex')
    })

    it('cache is cleared by clearModuleCaches', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(getHarnessName()).toBe('codex')
      delete process.env['CODEX_SESSION_ID']
      clearModuleCaches()
      expect(getHarnessName()).toBe('generic')
    })
  })
})
