import { tempConfigPath } from './helpers/temp-config.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unlinkSync } from 'node:fs'

import type { HookEvent } from '../src/hook_registry.js'

// vi.mock is hoisted — spy on recordStat while still calling through to the real implementation, mirroring tests/hooks_grep.test.ts's injection-detection pattern.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

// Redirects configPath() to a per-test-file temp file so the glob_dedup_min_matches wiring test can set a non-default config value deterministically. Mirrors tests/hooks_grep.test.ts.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

const _testConfigPath = tempConfigPath('tg-hooks-glob-config-test.toml')

import { isBroadCatchAllGlob, postGlobHandler, preGlobDedupHandler, preGlobHandler } from '../src/hooks_glob.js'
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

  // A Claude Code Glob answers with structured fields and no text, so a count read from text keys alone recorded 0 and the note never fired. CAPTURE: the tool_input and toolUseResult of a real Glob in transcript C--Projects-token-goat/69437660-bc84-4267-9ca8-cf709837dbe2.jsonl (Claude Code 2.1.268); the capture session behind tg_capture/events_run1.jsonl shows a Glob's toolUseResult byte-identical to its hook tool_response. The events_run1 Glob matched nothing, which reads as 0 either way, so it cannot show the difference.
  it('counts a structured Glob response at the default threshold, so the note fires on the identical repeat', () => {
    const toolInput = { pattern: 'scratch/audit2/*' }
    const filenames = ['mkpdf.mts', 'layout_quad.mts', 'layout_weapon.mts', 'regex_probe.mts', 'fence_probe.mts', 'deadline_destroy.mts', 'drain_cost.mts', 'locate_hang.mts', 'win_paths.mts', 'win2.mts', 'targets.json', 'win3.mts', 'locate_control.mts', 'layout_more.mts', 'layout_more2.mts', 'algo.mts', 'items_probe.mts', 'one.mts', 'algo_real.mts', 'notext.mts', 'pinned.ts', 'pinned_repro.mts', 'hangcheck.mts'].map((f) => 'scratch\\audit2\\' + f)
    const toolResponse = { filenames, durationMs: 631, numFiles: 23, truncated: false, totalMatches: 23, countIsComplete: true }
    postGlobHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Glob', toolInput, sessionId: 'test', raw: { tool_input: toolInput, tool_response: toolResponse } }))

    const result = preGlobDedupHandler(makeHookEvent({ toolName: 'Glob', toolInput, sessionId: 'test', raw: { tool_input: toolInput } }))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') expect(result.context).toContain('"scratch/audit2/*" already ran this session and returned 23 matches.')
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

  // Mutation guard: a lowered glob_dedup_min_matches must actually change behavior, proving the field drives this gate rather than a hardcoded literal happening to match the default.
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

describe('isBroadCatchAllGlob', () => {
  it('returns true for root wildcard patterns with empty or root path', () => {
    expect(isBroadCatchAllGlob('*')).toBe(true)
    expect(isBroadCatchAllGlob('**/*')).toBe(true)
    expect(isBroadCatchAllGlob('**')).toBe(true)
    expect(isBroadCatchAllGlob('*.*')).toBe(true)
    expect(isBroadCatchAllGlob('**/*.*')).toBe(true)
    expect(isBroadCatchAllGlob('**/*', '.')).toBe(true)
    expect(isBroadCatchAllGlob('**/*', './')).toBe(true)
    expect(isBroadCatchAllGlob('**/*', 'src')).toBe(true)
  })

  it('returns false for narrow patterns or deeply scoped paths', () => {
    expect(isBroadCatchAllGlob('*.ts')).toBe(false)
    expect(isBroadCatchAllGlob('src/**/*.ts')).toBe(false)
    expect(isBroadCatchAllGlob('**/*', 'src/utils/sub')).toBe(false)
    expect(isBroadCatchAllGlob('**/*.test.ts')).toBe(false)
  })
})

describe('preGlobHandler', () => {
  it('advises token-goat map --compact on broad recursive glob', () => {
    const result = preGlobHandler(globEvent('**/*', '.'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map --compact')
      expect(result.context).toContain('**/*')
    }
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'session_hint')).toBeDefined()
  })

  it('delegates narrow globs to preGlobDedupHandler without broad warning', () => {
    const result = preGlobHandler(globEvent('src/**/*.ts'))
    expect(result.hookType).toBe('pass')
  })
})
