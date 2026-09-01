import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- redirect configPath() to a per-file temp config so protect_recent_reads can be pinned to 0 deterministically (the default of 4 would otherwise exempt the single re-read under test from the doc-diff branch entirely). Mirrors tests/hooks_read.test.ts's config mock.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-hooks-compact-epoch-config-test.toml')

import type { HookEvent } from '../src/hook_registry.js'
import { preCompactHandler } from '../src/hooks_compact.js'
import { preReadHandler, postReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead, wasFileReadThisSession, markCompacted, getCompactedAt, exportSessionState, importSessionState, type SerializedSession } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'

const tmpFiles: string[] = []

function tmpDoc(content: string): string {
  const p = path.join(os.tmpdir(), `tg-epoch-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

// Drive the real first-read path: postReadHandler captures the snapshot the doc-diff branch later diffs against, and recordFileRead marks the read in the session ledger.
function firstRead(p: string, content: string): void {
  const postEvent: HookEvent = makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: p },
    sessionId: 'test',
    raw: { tool_response: content },
  })
  postReadHandler(postEvent)
  recordFileRead(normalizePath(p))
}

function readEvent(p: string): HookEvent {
  return makeHookEvent({ toolInput: { file_path: p }, sessionId: 'test' })
}

describe('compaction epoch invalidates in-context read state', () => {
  beforeEach(() => {
    clearModuleCaches()
    invalidateConfigCache()
    const cfg = defaultConfig()
    cfg.hints.protect_recent_reads = 0
    saveConfig(cfg)
  })

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.rmSync(f, { force: true })
      } catch {
        // best-effort
      }
    }
    invalidateConfigCache()
  })

  it('re-read with no intervening compaction still denies with "unchanged" exactly as today', () => {
    const content = '# Title\n\nSome content.\n'
    const p = tmpDoc(content)
    firstRead(p, content)

    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('unchanged since last read')
    }
  })

  it('re-read AFTER a compaction epoch is passed through as a full read (no diff, no "unchanged", no deny)', () => {
    const content = '# Title\n\nSome content.\n'
    const p = tmpDoc(content)
    firstRead(p, content)

    // The read is at or before Date.now(); step the clock past it so the epoch strictly follows the read even at coarse timer granularity.
    markCompacted(Date.now() + 1000)

    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).not.toBe('deny')
    const message = 'message' in result ? String(result.message ?? '') : ''
    expect(message).not.toContain('unchanged since last read')
    expect(message).not.toContain('already read this session')
    expect(message).not.toContain('```diff')
  })

  it('a changed doc re-read after the epoch serves the full read instead of a diff against an invisible baseline', () => {
    const content = '# Title\n\nSome content.\n'
    const p = tmpDoc(content)
    firstRead(p, content)
    fs.writeFileSync(p, '# Title\n\nSome content.\n\nA brand new paragraph that changed.\n')

    markCompacted(Date.now() + 1000)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).not.toBe('deny')
    const message = 'message' in result ? String(result.message ?? '') : ''
    expect(message).not.toContain('```diff')
  })

  it('a read made after the epoch is in context again and denies on its own re-read', () => {
    const content = '# Title\n\nSome content.\n'
    const p = tmpDoc(content)
    firstRead(p, content)
    markCompacted(Date.now() + 1000)

    // Re-establish the read on the far side of the epoch, stamping lastReadAt at the current clock. recordFileRead uses Date.now(), which is below the epoch we set 1s into the future, so pin the epoch back to a real past value first to model a compaction that has actually elapsed.
    importSessionState({ ...exportSessionState(), compactedAt: Date.now() - 1000 })
    firstRead(p, content)

    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
  })

  it('preserves wasEdited across the epoch (an edit is durable knowledge about the repo, not about context)', () => {
    const p = tmpDoc('# Title\n')
    const before = exportSessionState()
    importSessionState({
      ...before,
      files: [{ path: normalizePath(p), readCount: 1, lastReadAt: 1000, wasEdited: true, sizeBytes: 8 }],
    })

    markCompacted(5000)

    const entry = exportSessionState().files.find((f) => f.path === normalizePath(p))
    expect(entry?.wasEdited).toBe(true)
    expect(entry?.readCount).toBe(1)
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)
  })
})

// The merge is exercised through the real save -> disk -> merge -> load path (mergeSessionState is module-private and stays that way), matching how tests/session_store.test.ts covers every other merged key. A key that coerce() or mergeSessionState() silently drops fails here, which is the specific way this fix would ship as a cross-process no-op.
describe('compaction epoch persistence and merge', () => {
  let tmpHome: string
  let prevHome: string | undefined

  function empty(): SerializedSession {
    return { files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
  }

  // Write `state` to disk as the pre-existing session, then merge `mem` over it the way a second concurrent hook process would, and return the merged result.
  function saveThenMerge(sid: string, disk: SerializedSession, mem: SerializedSession): SerializedSession {
    importSessionState(disk)
    saveSessionState(sid)
    importSessionState(mem)
    saveSessionState(sid)
    importSessionState(empty())
    loadSessionState(sid)
    return exportSessionState()
  }

  beforeEach(() => {
    clearModuleCaches()
    invalidateConfigCache()
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-epoch-home-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  it('round-trips compactedAt through export/import', () => {
    markCompacted(1234567)
    expect(exportSessionState().compactedAt).toBe(1234567)
    importSessionState(exportSessionState())
    expect(getCompactedAt()).toBe(1234567)
  })

  it('is absent from the serialized state when no compaction happened', () => {
    expect(exportSessionState().compactedAt).toBeUndefined()
  })

  it('never moves the epoch backwards', () => {
    markCompacted(5000)
    markCompacted(1000)
    expect(getCompactedAt()).toBe(5000)
  })

  it('survives a save/load round-trip through disk', () => {
    importSessionState({ ...empty(), compactedAt: 4242 })
    saveSessionState('epoch-rt')
    importSessionState(empty())
    expect(getCompactedAt()).toBe(0)
    loadSessionState('epoch-rt')
    expect(getCompactedAt()).toBe(4242)
  })

  it('merges max-wins so a concurrent hook process cannot roll the epoch back', () => {
    expect(saveThenMerge('epoch-hi-disk', { ...empty(), compactedAt: 9000 }, { ...empty(), compactedAt: 3000 }).compactedAt).toBe(9000)
    expect(saveThenMerge('epoch-hi-mem', { ...empty(), compactedAt: 3000 }, { ...empty(), compactedAt: 9000 }).compactedAt).toBe(9000)
  })

  it('omits compactedAt from the merged state when neither side has one', () => {
    expect(saveThenMerge('epoch-none', empty(), empty()).compactedAt).toBeUndefined()
  })

  it('drops the sed line-range ledger of a side that predates the winning epoch', () => {
    const stale: SerializedSession = { ...empty(), compactedAt: 1000, fileLineRanges: [['/a.txt', [[1, 10]]]] }
    const fresh: SerializedSession = { ...empty(), compactedAt: 9000, fileLineRanges: [['/b.txt', [[5, 15]]]] }
    const paths = (saveThenMerge('epoch-ranges-drop', stale, fresh).fileLineRanges ?? []).map(([p]) => p)
    expect(paths).toContain('/b.txt')
    expect(paths).not.toContain('/a.txt')
  })

  it('keeps both sides\' line ranges when they agree on the epoch', () => {
    const a: SerializedSession = { ...empty(), compactedAt: 9000, fileLineRanges: [['/a.txt', [[1, 10]]]] }
    const b: SerializedSession = { ...empty(), compactedAt: 9000, fileLineRanges: [['/b.txt', [[5, 15]]]] }
    const paths = (saveThenMerge('epoch-ranges-keep', a, b).fileLineRanges ?? []).map(([p]) => p)
    expect(paths).toContain('/a.txt')
    expect(paths).toContain('/b.txt')
  })

  it('drops the served-output index of a side that predates the winning epoch', () => {
    // Same reason as the line ranges above, and it matters more here: a stale range only produces a
    // wrong hint, while a stale served-output id justifies *withholding* a read's body on the
    // grounds the model already holds it. After a compaction it no longer does.
    const stale: SerializedSession = { ...empty(), compactedAt: 1000, fileServedOutputs: [['/a.txt', ['id-a']]] }
    const fresh: SerializedSession = { ...empty(), compactedAt: 9000, fileServedOutputs: [['/b.txt', ['id-b']]] }
    const paths = (saveThenMerge('epoch-served-drop', stale, fresh).fileServedOutputs ?? []).map(([p]) => p)
    expect(paths).toContain('/b.txt')
    expect(paths).not.toContain('/a.txt')
  })

  it("keeps both sides' served-output indexes when they agree on the epoch", () => {
    const a: SerializedSession = { ...empty(), compactedAt: 9000, fileServedOutputs: [['/a.txt', ['id-a']]] }
    const b: SerializedSession = { ...empty(), compactedAt: 9000, fileServedOutputs: [['/b.txt', ['id-b']]] }
    const paths = (saveThenMerge('epoch-served-keep', a, b).fileServedOutputs ?? []).map(([p]) => p)
    expect(paths).toContain('/a.txt')
    expect(paths).toContain('/b.txt')
  })

  it('does not resurrect a stale readCount-based read across processes -- the epoch, not the counter, is what invalidates', () => {
    const entry = { path: '/x.ts', readCount: 3, lastReadAt: 1000, wasEdited: true, sizeBytes: 10 }
    const merged = saveThenMerge('epoch-vs-count', { ...empty(), files: [entry] }, { ...empty(), files: [entry], compactedAt: 5000 })
    expect(merged.compactedAt).toBe(5000)
    expect(merged.files[0]?.readCount).toBeGreaterThan(0)
    expect(merged.files[0]?.wasEdited).toBe(true)
    expect(wasFileReadThisSession('/x.ts')).toBe(false)
  })
})

describe('preCompactHandler stamps the epoch', () => {
  beforeEach(() => {
    clearModuleCaches()
    invalidateConfigCache()
  })

  afterEach(() => {
    invalidateConfigCache()
  })

  it('stamps the epoch when compact_assist is enabled, and still emits the manifest', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.enabled = true
    saveConfig(cfg)
    recordFileRead(normalizePath(tmpDoc('# Doc\n')))

    expect(getCompactedAt()).toBe(0)
    const out = preCompactHandler(makeHookEvent({ eventName: 'pre_compact', toolName: '', sessionId: 'test' }))
    expect(getCompactedAt()).toBeGreaterThan(0)
    expect(out.hookType).toBe('context')
  })

  it('stamps the epoch even when compact_assist is disabled -- compaction happens either way', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.enabled = false
    saveConfig(cfg)

    expect(getCompactedAt()).toBe(0)
    const out = preCompactHandler(makeHookEvent({ eventName: 'pre_compact', toolName: '', sessionId: 'test' }))
    expect(out.hookType).toBe('pass')
    expect(getCompactedAt()).toBeGreaterThan(0)
  })

  it('builds the manifest from the pre-compaction read set, before the epoch invalidates it', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.enabled = true
    saveConfig(cfg)
    const p = tmpDoc('# Doc\n' + 'x'.repeat(4096))
    recordFileRead(normalizePath(p))

    const out = preCompactHandler(makeHookEvent({ eventName: 'pre_compact', toolName: '', sessionId: 'test' }))
    expect(out.hookType).toBe('context')
    if (out.hookType === 'context') {
      expect(out.context).toContain(path.basename(p))
    }
  })
})
