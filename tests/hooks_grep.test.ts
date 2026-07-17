import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HookEvent } from '../src/hook_registry.js'

// vi.mock is hoisted — spy on recordStat while still calling through to the real
// implementation, mirroring tests/hooks_fetch.test.ts's injection-detection pattern.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

// Redirects configPath() to a per-test-file temp file so the grep_dedup_min_matches wiring
// test can set a non-default config value deterministically. Mirrors tests/hooks_bash.test.ts.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

const _testConfigPath = join(tmpdir(), `tg-hooks-grep-config-test-${process.pid}.toml`)

import { postGrepHandler, preGrepDedupHandler } from '../src/hooks_grep.js'
import { recordStat } from '../src/stats.js'
import { clearModuleCaches } from '../src/reset.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'

function grepEvent(pattern: string, path = '/project/src', outputMode = 'files_with_matches'): HookEvent {
  return makeHookEvent({
    toolName: 'Grep',
    toolInput: { pattern, path, output_mode: outputMode },
    sessionId: 'test',
  })
}

function grepPostEvent(pattern: string, response: string, path = '/project/src', outputMode = 'files_with_matches'): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Grep',
    toolInput: { pattern, path, output_mode: outputMode },
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

describe('postGrepHandler', () => {
  it('records a match count from the tool response and always passes', () => {
    const result = postGrepHandler(grepPostEvent('useEffect', 'a.ts\nb.ts\nc.ts\n'))
    expect(result.hookType).toBe('pass')
  })

  it('ignores non-Grep events', () => {
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Read', toolInput: {}, raw: { tool_response: 'x' } })
    const result = postGrepHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('ignores an event with no pattern', () => {
    const event = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Grep', toolInput: { path: '/x' }, raw: { tool_response: 'x' } })
    const result = postGrepHandler(event)
    expect(result.hookType).toBe('pass')
  })
})

describe('preGrepDedupHandler', () => {
  it('passes on the first occurrence of a pattern (nothing recorded yet)', () => {
    const result = preGrepDedupHandler(grepEvent('useEffect'))
    expect(result.hookType).toBe('pass')
  })

  it('emits a recall context hint when an identical Grep repeats above grep_dedup_min_matches (default 5)', () => {
    postGrepHandler(grepPostEvent('useEffect', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n'))

    const result = preGrepDedupHandler(grepEvent('useEffect'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('useEffect')
      expect(result.context).toContain('6 matches')
    }
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'grep_dedup_hint')).toBeDefined()
  })

  it('stays silent when the prior match count is below grep_dedup_min_matches', () => {
    postGrepHandler(grepPostEvent('rareTerm', 'only.ts\n'))

    const result = preGrepDedupHandler(grepEvent('rareTerm'))
    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'grep_dedup_hint')).toBeUndefined()
  })

  it('does not fire for a different pattern at the same path (distinct signature)', () => {
    postGrepHandler(grepPostEvent('useEffect', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n'))

    const result = preGrepDedupHandler(grepEvent('useState'))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for the same pattern at a different path (distinct signature)', () => {
    postGrepHandler(grepPostEvent('useEffect', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', '/project/src/a'))

    const result = preGrepDedupHandler(grepEvent('useEffect', '/project/src/b'))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for the same pattern+path under a different output_mode (distinct signature)', () => {
    postGrepHandler(grepPostEvent('useEffect', 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', '/project/src', 'files_with_matches'))

    const result = preGrepDedupHandler(grepEvent('useEffect', '/project/src', 'content'))
    expect(result.hookType).toBe('pass')
  })

  it('ignores non-Grep events', () => {
    const event = makeHookEvent({ toolName: 'Read', toolInput: {} })
    const result = preGrepDedupHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for the same pattern+path+output_mode+glob under a different -i case-sensitivity (distinct signature)', () => {
    const insensitive = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'Grep',
      toolInput: { pattern: 'TODO', path: '/project/src', output_mode: 'files_with_matches', '-i': true },
      raw: { tool_response: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n' },
    })
    postGrepHandler(insensitive)

    const sensitive = makeHookEvent({
      toolName: 'Grep',
      toolInput: { pattern: 'TODO', path: '/project/src', output_mode: 'files_with_matches' },
    })
    const result = preGrepDedupHandler(sensitive)
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for the same pattern+path+output_mode+glob under a different -A context (distinct signature)', () => {
    const withContext = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'Grep',
      toolInput: { pattern: 'useEffect', path: '/project/src', output_mode: 'content', '-A': 3 },
      raw: { tool_response: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n' },
    })
    postGrepHandler(withContext)

    const withoutContext = makeHookEvent({
      toolName: 'Grep',
      toolInput: { pattern: 'useEffect', path: '/project/src', output_mode: 'content' },
    })
    const result = preGrepDedupHandler(withoutContext)
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for the same pattern+path+output_mode+glob under a different head_limit (distinct signature)', () => {
    const limited = makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'Grep',
      toolInput: { pattern: 'useState', path: '/project/src', output_mode: 'content', head_limit: 10 },
      raw: { tool_response: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n' },
    })
    postGrepHandler(limited)

    const unlimited = makeHookEvent({
      toolName: 'Grep',
      toolInput: { pattern: 'useState', path: '/project/src', output_mode: 'content' },
    })
    const result = preGrepDedupHandler(unlimited)
    expect(result.hookType).toBe('pass')
  })

  // Mutation guard: a lowered grep_dedup_min_matches must actually change behavior, proving
  // the field drives this gate rather than a hardcoded literal happening to match the default.
  it('grep_dedup_min_matches wiring: a lowered threshold surfaces a hint 2 identical Greps would not otherwise clear', () => {
    postGrepHandler(grepPostEvent('rareTerm', 'only.ts\ntwo.ts\n'))
    expect(preGrepDedupHandler(grepEvent('rareTerm')).hookType).toBe('pass')

    const cfg = defaultConfig()
    cfg.hints.grep_dedup_min_matches = 2
    saveConfig(cfg)
    invalidateConfigCache()

    const result = preGrepDedupHandler(grepEvent('rareTerm'))
    expect(result.hookType).toBe('context')
  })

  it('grep_dedup_min_matches=0 fires the hint even for a zero-match repeat', () => {
    postGrepHandler(grepPostEvent('nothingHere', ''))

    const cfg = defaultConfig()
    cfg.hints.grep_dedup_min_matches = 0
    saveConfig(cfg)
    invalidateConfigCache()

    const result = preGrepDedupHandler(grepEvent('nothingHere'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('0 matches')
    }
  })
})
