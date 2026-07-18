import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HookEvent } from '../src/hook_registry.js'

// vi.mock is hoisted — spy on recordStat while still calling through to the real
// implementation, mirroring tests/hooks_grep.test.ts's injection-detection pattern.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

// Redirects configPath() to a per-test-file temp file so the glob_dedup_min_matches wiring
// test can set a non-default config value deterministically. Mirrors tests/hooks_grep.test.ts.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

const _testConfigPath = join(tmpdir(), `tg-hooks-glob-config-test-${process.pid}.toml`)

import { postGlobHandler, preGlobDedupHandler } from '../src/hooks_glob.js'
import { recordStat } from '../src/stats.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'

function globEvent(pattern: string, path = '/project/src'): HookEvent {
  return makeHookEvent({
    toolName: 'Glob',
    toolInput: { pattern, path },
    sessionId: 'test',
  })
}

function globPostEvent(pattern: string, response: string, path = '/project/src'): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Glob',
    toolInput: { pattern, path },
    sessionId: 'test',
    raw: { tool_response: response },
  })
}

beforeEach(() => {
  clearModuleCaches()
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
  try {
    unlinkSync(_testConfigPath)
  } catch {
    // ok -- may not exist
  }
})

describe('postGlobHandler', () => {
  it('records a match count from the tool response and always passes', () => {
    const result = postGlobHandler(globPostEvent('**/*.ts', 'a.ts\nb.ts\nc.ts\n'))
    expect(result.hookType).toBe('pass')
  })

  it('ignores non-Glob events', () => {
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Read', toolInput: {}, raw: { tool_response: 'x' } })
    const result = postGlobHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('ignores an event with no pattern', () => {
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Glob', toolInput: { path: '/x' }, raw: { tool_response: 'x' } })
    const result = postGlobHandler(event)
    expect(result.hookType).toBe('pass')
  })
})

describe('preGlobDedupHandler', () => {
  it('passes on the first occurrence of a pattern (nothing recorded yet)', () => {
    const result = preGlobDedupHandler(globEvent('**/*.ts'))
    expect(result.hookType).toBe('pass')
  })

  it('emits a recall context hint when an identical Glob repeats above glob_dedup_min_matches (default 5)', () => {
    postGlobHandler(globPostEvent('**/*.ts', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n'))

    const result = preGlobDedupHandler(globEvent('**/*.ts'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('**/*.ts')
      expect(result.context).toContain('6 matches')
    }
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'glob_dedup_hint')).toBeDefined()
  })

  it('stays silent when the prior match count is below glob_dedup_min_matches', () => {
    postGlobHandler(globPostEvent('rare/*.ts', 'only.ts\n'))

    const result = preGlobDedupHandler(globEvent('rare/*.ts'))
    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'glob_dedup_hint')).toBeUndefined()
  })

  it('does not fire for a different pattern at the same path (distinct signature)', () => {
    postGlobHandler(globPostEvent('**/*.ts', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n'))

    const result = preGlobDedupHandler(globEvent('**/*.tsx'))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for the same pattern at a different path (distinct signature)', () => {
    postGlobHandler(globPostEvent('**/*.ts', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', '/project/src/a'))

    const result = preGlobDedupHandler(globEvent('**/*.ts', '/project/src/b'))
    expect(result.hookType).toBe('pass')
  })

  it('ignores non-Glob events', () => {
    const event = makeHookEvent({ toolName: 'Read', toolInput: {} })
    const result = preGlobDedupHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('fails open (passes) when the session state is corrupt / toolInput throws unexpected shape', () => {
    const event = makeHookEvent({ toolName: 'Glob', toolInput: { pattern: 123 } })
    const result = preGlobDedupHandler(event)
    expect(result.hookType).toBe('pass')
  })

  // Mutation guard: a lowered glob_dedup_min_matches must actually change behavior, proving
  // the field drives this gate rather than a hardcoded literal happening to match the default.
  it('glob_dedup_min_matches wiring: a lowered threshold surfaces a hint 2 identical Globs would not otherwise clear', () => {
    postGlobHandler(globPostEvent('rare/*.ts', 'only.ts\ntwo.ts\n'))
    expect(preGlobDedupHandler(globEvent('rare/*.ts')).hookType).toBe('pass')

    const cfg = defaultConfig()
    cfg.hints.glob_dedup_min_matches = 2
    saveConfig(cfg)
    invalidateConfigCache()

    const result = preGlobDedupHandler(globEvent('rare/*.ts'))
    expect(result.hookType).toBe('context')
  })

  it('glob_dedup_min_matches=0 fires the hint even for a zero-match repeat', () => {
    postGlobHandler(globPostEvent('nothing/*.ts', ''))

    const cfg = defaultConfig()
    cfg.hints.glob_dedup_min_matches = 0
    saveConfig(cfg)
    invalidateConfigCache()

    const result = preGlobDedupHandler(globEvent('nothing/*.ts'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('0 matches')
    }
  })
})
