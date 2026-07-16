import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- this redirects configPath() to a per-test-file temp file so the
// hints.reread_deny / hints.reread_deny_min_bytes wiring tests below can set a non-default
// config value deterministically. Mirrors tests/hooks_bash.test.ts's config.toml mock.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = path.join(os.tmpdir(), `tg-hooks-read-config-test-${process.pid}.toml`)

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler, postReadHandler, buildLineDiff } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead, wasFileReadThisSession, getSessionId, importSessionState } from '../src/session.js'
import { saveSessionState, SESSIONS_SUBDIR } from '../src/session_store.js'
import { tokenGoatHome } from '../src/disk_cache.js'
import { storeCompact, setSkillOutputsDirForTesting, contentHash } from '../src/skill_cache.js'
import { compactPathFor, writeCompact } from '../src/doc_compact.js'
import { load as snapshotLoad } from '../src/snapshots.js'
import { FILE_TYPE_THRESHOLDS } from '../src/hints/file_type_handler.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { summarize } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

const tmpFiles: string[] = []

// Unrecognized extension (deliberately not .txt) so callers testing the generic
// size-based gate exercise that path specifically, not one of the per-type handlers
// dispatchFileTypeHandler() now short-circuits .txt/.csv/.html/etc to.
function makeTmpFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.bin`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function _makeTmpMdFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

const tmpDirs: string[] = []

// Creates a tmp file with an exact basename (in its own throwaway dir) — needed for
// manifest-file hint tests, which key off the literal filename (e.g. "package.json").
function makeTmpFileNamed(basename: string, content = '{}'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-read-named-'))
  const p = path.join(dir, basename)
  fs.writeFileSync(p, content)
  tmpDirs.push(dir)
  return p
}

function readEvent(filePath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
  })
}

// A Read call with offset/limit — the real Read tool schema's line-window params.
function readEventWithRange(filePath: string, offset?: number, limit?: number): HookEvent {
  const toolInput: Record<string, unknown> = { file_path: filePath }
  if (offset !== undefined) toolInput['offset'] = offset
  if (limit !== undefined) toolInput['limit'] = limit
  return makeHookEvent({
    toolName: 'Read',
    toolInput,
    sessionId: 'test',
  })
}

// A file made of many short lines totaling roughly `totalBytes` — realistic multi-line
// content (as opposed to a single padded-out line), so line-based offset/limit slicing
// actually has lines to work with.
function makeTmpMultilineFile(totalBytes: number): string {
  return makeTmpMultilineFileWithExt(totalBytes, 'bin')
}

// Same shape as makeTmpMultilineFile but with a configurable extension, so offset/limit
// narrowing can be exercised through the HTML/CSV per-type branches (not just .txt).
function makeTmpMultilineFileWithExt(totalBytes: number, ext: string): string {
  const lineTemplate = (i: number) => `line ${i.toString().padStart(6, '0')}: some sample content here\n`
  const perLine = lineTemplate(0).length
  const lineCount = Math.ceil(totalBytes / perLine)
  let content = ''
  for (let i = 0; i < lineCount; i++) content += lineTemplate(i)
  const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function grepEvent(filePath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Grep',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
  })
}

// The real Grep tool schema uses `path` (not `file_path`) for the search target.
function grepPathEvent(searchPath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Grep',
    toolInput: searchPath === undefined ? {} : { path: searchPath },
    sessionId: 'test',
  })
}

// Pins hints.protect_recent_reads=0 for tests that assert an unconditional re-read deny but
// don't otherwise mock config -- hints.protect_recent_reads defaults to 4 in production, which
// would trivially exempt any of these small (one/two-file) test sessions (rank < 4 is nearly
// always true). Writes a minimal raw TOML file directly rather than saveConfig(defaultConfig()),
// so it doesn't also serialize unrelated defaults (e.g. compact_assist.auto_trigger_multiplier)
// that a sibling test relies on being absent from the file entirely.
function pinProtectRecentReadsToZero(): void {
  fs.writeFileSync(_testConfigPath, '[hints]\nprotect_recent_reads = 0\n', 'utf8')
  invalidateConfigCache()
}

function unpinProtectRecentReadsToZero(): void {
  invalidateConfigCache()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ok -- may not exist
  }
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  unpinProtectRecentReadsToZero()
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d === undefined) continue
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('preReadHandler', () => {
  it('returns pass when no file_path in input', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('returns a re-read context hint when the file was already read (small file)', () => {
    const p = makeTmpFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read this session')
      expect(result.context).toContain('token-goat read/section/symbol')
    }
  })

  describe('hints.quiet_hours wiring', () => {
    afterEach(() => {
      invalidateConfigCache()
      vi.useRealTimers()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    it('suppresses the "already read" context hint during the configured window (regression: field had zero consumers)', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 0, 1, 23, 0))
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.quiet_hours = '22:00-06:00'
      saveConfig(cfg)
      invalidateConfigCache()

      const p = makeTmpFile()
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('pass')
    })

    it('does not suppress the hint outside the configured window', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0))
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.quiet_hours = '22:00-06:00'
      saveConfig(cfg)
      invalidateConfigCache()

      const p = makeTmpFile()
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('context')
    })

    it('never suppresses a correctness-relevant deny (large re-read), even during the window', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 0, 1, 23, 0))
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.quiet_hours = '22:00-06:00'
      saveConfig(cfg)
      invalidateConfigCache()

      const p = makeTmpFile('x'.repeat(60 * 1024))
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('already read this session')
      }
    })
  })

  it('denies re-read of a large file (>50KB) that was already read this session', () => {
    pinProtectRecentReadsToZero()
    const p = makeTmpFile('x'.repeat(60 * 1024))
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat read/section/symbol')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  // Regression (#247): hints.reread_deny/hints.reread_deny_min_bytes were defined, validated,
  // persisted, and displayed in config.ts but had zero consumers -- the real deny logic in
  // preReadHandler fired unconditionally, gated only by a hardcoded REREAD_DENY_BYTES constant.
  describe('hints.reread_deny / reread_deny_min_bytes wiring', () => {
    afterEach(() => {
      invalidateConfigCache()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    it('hints.reread_deny=false suppresses the deny for a file that would otherwise be denied', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.reread_deny = false
      saveConfig(cfg)

      // Large enough to trip the size-based deny, and re-read enough times (3rd read) to also
      // trip the count-based deny -- both must be suppressed with reread_deny off.
      const p = makeTmpFile('x'.repeat(60 * 1024))
      const normalized = normalizePath(p)
      recordFileRead(normalized)
      recordFileRead(normalized)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('already read this session')
      }
    })

    it('hints.reread_deny_min_bytes raises the size threshold a re-read must clear to be denied', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      // Well above this file's size, so the size-based deny at the default 50KB threshold would
      // no longer fire once the configured threshold is honored.
      cfg.hints.reread_deny_min_bytes = 200 * 1024
      saveConfig(cfg)

      const p = makeTmpFile('x'.repeat(60 * 1024))
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('context')
    })

    it('hints.reread_deny_min_bytes lowers the size threshold so a smaller re-read is denied', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.reread_deny_min_bytes = 1024
      saveConfig(cfg)

      // Below the default 50KB threshold but above the configured 1KB one.
      const p = makeTmpFile('x'.repeat(2 * 1024))
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
    })
  })

  // Regression: hints.protect_recent_reads was defined, validated, persisted, and displayed
  // in config.ts but had zero consumers -- neither reread-deny call site (the doc/source
  // diff-on-reread branch, nor the generic re-read-dedup fallback) exempted recently-read
  // files, so the deny fired on the very first re-read regardless of how recently the file
  // had been touched.
  describe('hints.protect_recent_reads wiring', () => {
    afterEach(() => {
      invalidateConfigCache()
      vi.useRealTimers()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    it('protect_recent_reads=0 still denies a re-read exactly as today (generic fallback, non-diffable file)', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      saveConfig(cfg)

      const p = makeTmpFile('x'.repeat(60 * 1024))
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('already read this session')
      }
    })

    it('protect_recent_reads=0 still denies the doc-diffable unchanged-since-last-read re-read exactly as today', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      saveConfig(cfg)

      const content = '# Title\n\nSome content.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
      )
      fs.writeFileSync(p, content)
      tmpFiles.push(p)

      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content },
      }
      postReadHandler(postEvent)
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
      }
    })

    it('exempts a just-read file within the protected window from the generic re-read deny (non-diffable file)', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 5
      saveConfig(cfg)

      const p = makeTmpFile('x'.repeat(60 * 1024))
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).not.toBe('deny')
    })

    it('exempts a just-read file within the protected window from the doc-diffable unchanged-since-last-read deny', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 5
      saveConfig(cfg)

      const content = '# Title\n\nSome content.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
      )
      fs.writeFileSync(p, content)
      tmpFiles.push(p)

      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content },
      }
      postReadHandler(postEvent)
      recordFileRead(normalizePath(p))

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).not.toBe('deny')
    })

    it('still denies a re-read once other more-recently-read files push the file past the protected rank window', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 2
      saveConfig(cfg)

      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))

      const target = makeTmpFile('x'.repeat(60 * 1024))
      recordFileRead(normalizePath(target))

      // Three other files read strictly after the target, each with an advancing timestamp,
      // push the target's recency rank to 3 -- past the configured window of 2.
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, i + 1))
        recordFileRead(normalizePath(makeTmpFile(`other-${i}`)))
      }

      const result = preReadHandler(readEvent(target))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('already read this session')
      }
    })
  })

  // Regression: hints.min_file_lines_for_hint was defined, validated, persisted, and
  // displayed in config.ts but had zero consumers -- surgicalHint() always appended its
  // suggestion regardless of file size.
  describe('hints.min_file_lines_for_hint wiring', () => {
    afterEach(() => {
      invalidateConfigCache()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    function makeUnchangedMdFile(): string {
      const content = '# Title\n\nSome content.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
      )
      fs.writeFileSync(p, content)
      tmpFiles.push(p)

      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content },
      }
      postReadHandler(postEvent)
      recordFileRead(normalizePath(p))
      return p
    }

    it('hints.min_file_lines_for_hint=0 includes the surgical-read suggestion for a small file', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.min_file_lines_for_hint = 0
      saveConfig(cfg)

      const p = makeUnchangedMdFile()
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
        expect(result.message).toContain('token-goat section')
      }
    })

    it('hints.min_file_lines_for_hint above the file line count suppresses the suggestion', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.min_file_lines_for_hint = 1000
      saveConfig(cfg)

      const p = makeUnchangedMdFile()
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
        expect(result.message).not.toContain('token-goat section')
        // No trailing whitespace left behind by the suppressed suggestion.
        expect(result.message.endsWith(' ')).toBe(false)
      }
    })
  })

  // Regression: hints.truncated_read_min_lines was defined, validated, persisted, and
  // displayed in config.ts but had zero consumers -- the truncated-read deny in the
  // doc/source diff-on-reread branch fired unconditionally whenever
  // wasFileTruncatedThisSession() was true, regardless of the file's line count.
  describe('hints.truncated_read_min_lines wiring', () => {
    afterEach(() => {
      invalidateConfigCache()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    function makeTruncatedMdFile(): string {
      const content = '# Title\n\nSome content.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
      )
      fs.writeFileSync(p, content)
      tmpFiles.push(p)

      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content + ' [Truncated: file too large, showing first 33K tokens]' },
      }
      postReadHandler(postEvent)
      return p
    }

    it('hints.truncated_read_min_lines=0 denies with the truncated-read message for a small file', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.truncated_read_min_lines = 0
      saveConfig(cfg)

      const p = makeTruncatedMdFile()
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('truncated on last read (>33K tokens)')
        expect(result.message).toContain('token-goat skeleton')
      }
    })

    it('hints.truncated_read_min_lines above the file line count falls through to the next branch', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.truncated_read_min_lines = 1000
      saveConfig(cfg)

      const p = makeTruncatedMdFile()
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        // The truncation-specific deny is suppressed by the line-count gate; control falls
        // through to the next applicable branch (here, the unchanged-since-last-read deny,
        // since postReadHandler's snapshot logic still ran and the file content is
        // unchanged), never straight through to passOutput().
        expect(result.message).not.toContain('truncated on last read (>33K tokens)')
        expect(result.message).toContain('unchanged since last read')
      }
    })
  })

  // Regression: the generic re-read-dedup fallback (non-doc/non-source-diffable files, e.g.
  // .bin) has its own, textually-identical truncation deny ("Item 1" inside
  // `if (config.hints.reread_deny)`), a separate call site from the doc/source diff-on-reread
  // branch above. It must be gated by the same hints.truncated_read_min_lines threshold, not
  // left unconditional.
  describe('hints.truncated_read_min_lines wiring (generic re-read-dedup fallback)', () => {
    afterEach(() => {
      invalidateConfigCache()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    it('above the file line count suppresses the truncation deny and falls through to the context hint', () => {
      const cfg = defaultConfig()
      cfg.hints.protect_recent_reads = 0
      cfg.hints.truncated_read_min_lines = 1000
      saveConfig(cfg)

      const p = makeTmpFile('some content')
      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: 'content here [Truncated: file too large, showing first 33K tokens]' },
      }
      postReadHandler(postEvent)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).not.toBe('deny')
      if (result.hookType === 'context') {
        expect(result.context).not.toContain('truncated on last read (>33K tokens)')
      }
    })
  })

  it('returns a large-file context hint for files between 100KB and 500KB', () => {
    const p = makeTmpFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
      expect(result.context).toContain('token-goat skeleton')
    }
  })

  it('denies first read of very large files (>500KB)', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  // Regression coverage for the pressure-scaled deny threshold (hints.large_read_redirect_bytes):
  // the same 150KB read that gets only a soft context hint at 'cool' pressure (see the sibling
  // 100KB-500KB test above) must hard-deny once the session is under 'critical' context pressure,
  // since that tier scales the 512KB base threshold down to ~92KB.
  // saveSessionState merges with whatever is already on disk under the same session id
  // (session_store.ts's mergeSessionState unions bashOutputs rather than replacing them --
  // deliberate, to survive concurrent same-session hook processes). Tests that seed synthetic
  // bashOutputs to hit a specific pressure tier must delete the on-disk file afterward, or the
  // entries silently accumulate across every other test in this file/worker that also resolves
  // to the same getSessionId() value, corrupting their pressure math.
  function clearSessionStateFile(sessionId: string): void {
    try {
      fs.unlinkSync(path.join(tokenGoatHome(), SESSIONS_SUBDIR, sessionId + '.json'))
    } catch {
      // ok -- may not exist
    }
  }

  it('tightens the deny threshold to a hard deny under critical context pressure', () => {
    // Pin harness detection so this doesn't depend on the ambient environment the test
    // runner happens to execute in (getContextPressure's effective window is
    // CONTEXT_AUTOCOMPACT_TOKENS * getAutoTriggerMultiplier() -- 'generic''s multiplier is
    // 1.0, matching the 561,000-token 'critical' floor computed below unscaled).
    const savedHarnessOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
    try {
      const sessionId = getSessionId()
      // bashOutputs are never capped like files are (MAX_FILES) -- 2000 synthetic entries at
      // 500 tokens each comfortably clears the 561,000-token 'critical' floor (0.85 * 660,000).
      const bashOutputs: Array<[string, string]> = Array.from({ length: 2000 }, (_, i) => [
        `cmd${i}`,
        `output${i}`,
      ])
      importSessionState({
        files: [],
        hintsShown: [],
        webFetches: [],
        bashOutputs,
        curlDownloads: [],
      })
      saveSessionState(sessionId)

      const p = makeTmpFile('x'.repeat(150 * 1024))
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('is very large')
      }
    } finally {
      clearSessionStateFile(getSessionId())
      if (savedHarnessOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarnessOverride
    }
  })

  // Regression: hints.context_threshold_advisory was defined, validated, persisted, and
  // displayed in config.ts but had zero consumers -- the large-file structural-nav hint never
  // surfaced context-pressure state regardless of how full the session window was.
  describe('hints.context_threshold_advisory wiring', () => {
    afterEach(() => {
      invalidateConfigCache()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
      clearSessionStateFile(getSessionId())
    })

    function fillContextToHotTier(): void {
      const sessionId = getSessionId()
      // pressureRawTotal (src/compact.ts) = CATALOG_TOKENS (10,800) + bashCount * 500 when no
      // observedToolTokens are set. 1000 entries -> 510,800 tokens -> 0.774 fill fraction under
      // the 'generic' harness's 1.0 multiplier (660,000 * 1.0 window) -- squarely in the 'hot'
      // band (>= 0.70, < 0.85) without crossing into 'critical'.
      const bashOutputs: Array<[string, string]> = Array.from({ length: 1000 }, (_, i) => [
        `cmd${i}`,
        `output${i}`,
      ])
      importSessionState({
        files: [],
        hintsShown: [],
        webFetches: [],
        bashOutputs,
        curlDownloads: [],
      })
      saveSessionState(sessionId)
    }

    it('appends a context-pressure advisory to the large-file hint under hot pressure', () => {
      const savedHarnessOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
      try {
        fillContextToHotTier()

        const p = makeTmpFile('x'.repeat(150 * 1024))
        const result = preReadHandler(readEvent(p))
        expect(result.hookType).toBe('context')
        if (result.hookType === 'context') {
          expect(result.context).toContain('is large')
          expect(result.context).toContain('Context pressure: hot')
        }
      } finally {
        if (savedHarnessOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
        else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarnessOverride
      }
    })

    it('context_threshold_advisory=false suppresses the advisory suffix even under hot pressure', () => {
      const cfg = defaultConfig()
      cfg.hints.context_threshold_advisory = false
      saveConfig(cfg)
      invalidateConfigCache()

      const savedHarnessOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
      try {
        fillContextToHotTier()

        const p = makeTmpFile('x'.repeat(150 * 1024))
        const result = preReadHandler(readEvent(p))
        expect(result.hookType).toBe('context')
        if (result.hookType === 'context') {
          expect(result.context).toContain('is large')
          expect(result.context).not.toContain('Context pressure')
        }
      } finally {
        if (savedHarnessOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
        else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarnessOverride
      }
    })

    it('cool pressure never gets the advisory suffix (default config, no session fill)', () => {
      const p = makeTmpFile('x'.repeat(150 * 1024))
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).not.toContain('Context pressure')
      }
    })
  })

  // Regression coverage for the false "retry with offset/limit" advice bug: the deny message
  // told callers to retry with offset/limit, but the hook never read those params at all, so
  // the retry always hit the byte-identical deny. These tests drive the fix end-to-end.
  it('allows a large file read when offset/limit narrows it to a small slice', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    // Whole-file request still denies (sanity check the fixture is genuinely large).
    const wholeFile = preReadHandler(readEvent(p))
    expect(wholeFile.hookType).toBe('deny')

    // A real, bounded offset/limit request covering only a handful of lines is a tiny read —
    // it must be let through instead of gating on the whole file's size.
    const result = preReadHandler(readEventWithRange(p, 1, 50))
    expect(result.hookType).not.toBe('deny')
  })

  it('still denies a large file read with no offset/limit (a whole-file request)', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  it('still denies a large file read when offset/limit is given but the requested window is itself still large', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    // limit covers effectively the whole file — not a genuinely narrowed request.
    const result = preReadHandler(readEventWithRange(p, 1, 100_000))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      // True advice now that offset/limit is honored: tells the caller to narrow it further,
      // not to blindly retry with offset/limit again (which is what caused the original bug).
      expect(result.message).toContain('narrow the range further')
    }
  })

  // Regression guard: estimateRequestedSlice already clamps a sub-1 offset up to 1, but used to
  // pass a negative limit straight through unguarded. scanRequestedSlice computes
  // `windowEnd = offset + limit`; a negative limit makes windowEnd < offset, so the byte counter
  // never advances (the [offset, windowEnd) window is empty) and the very first line break trips
  // the "window closed" branch, returning a fabricated {bytes: 0, trustworthy: true} almost
  // immediately -- telling the pre-read size gate the requested window is trivially small even
  // though a Read call with a negative limit has no well-defined real-world size. That silently
  // bypassed the large-file deny for a genuinely huge file. Fixed by treating a non-positive
  // limit the same as a missing one: fall back to `kind: 'unbounded'` and gate on the whole file.
  it('does not treat a negative --limit as a trustworthy small slice on a large file', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    const result = preReadHandler(readEventWithRange(p, 1, -1))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  // Regression coverage for the undercounted-trustworthy scan-cap bug: scanRequestedSlice's
  // cap-hit branch used to mark its partial in-window byte count "trustworthy" any time the
  // window had merely started (lineNumber >= offset), even though the window hadn't closed and
  // the count was only "bytes seen so far", not the true window size. That handed the large-file
  // gate an undercounted figure and let a genuinely huge read pass as safe.
  it('does not let a huge read pass as safe via an undercounted trustworthy slice estimate when the scan cap is hit mid-window (fail-on-buggy: the cap-hit branch previously trusted a partial in-window byte count whenever the window had started, instead of falling back to gating on the whole file)', () => {
    // 2.3MB file: comfortably past the 2MB scan cap, so the scan gives up before EOF. With
    // offset=55100 sitting just below the ~55189th line where the cap lands, and limit=500000
    // keeping the window open well past the cap, the scan has only counted a few KB in-window
    // by the time it gives up — the old bug trusted that tiny partial count and let this
    // through, even though the true requested window is enormous relative to the file.
    const p = makeTmpMultilineFile(2_300_000)

    const result = preReadHandler(readEventWithRange(p, 55100, 500000))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  it('denies a large mostly-single-line (base64-like) file without suggesting offset/limit, since line-windowing cannot shrink it', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    // Retrying with offset/limit — exactly what the old message suggested — must not be
    // treated as a valid narrowing for this shape, since there's ~1 line to window over.
    const result = preReadHandler(readEventWithRange(p, 1, 50))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      expect(result.message).toContain('mostly one long line')
      // Must not repeat the old, false "use offset/limit" suggestion for this content shape.
      expect(result.message).not.toContain('Use Read with offset/limit to sample specific sections')
      expect(result.message).not.toContain('narrow the range further')
    }
  })

  it('allows a mid-size (20-100KB) .txt read when offset/limit narrows it to a small slice — exercises the universal file-type-handler branch (handleTxt), not just the top-level large-file gate', () => {
    // 50KB: above FILE_TYPE_THRESHOLDS.txt (20KB) but below LARGE_FILE_BYTES (100KB), so this
    // is gated by the per-type handler branch, not the earlier whole-file size branch.
    const p = makeTmpMultilineFileWithExt(50 * 1024, 'txt')

    const whole = preReadHandler(readEvent(p))
    expect(whole.hookType).toBe('deny')

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))
    expect(sliced.hookType).not.toBe('deny')
  })

  it('allows a mid-size (50-100KB) .html read when offset/limit narrows it to a small slice — exercises the universal file-type-handler branch (handleHtml), not just the top-level large-file gate', () => {
    // 60KB: above FILE_TYPE_THRESHOLDS.html (50KB) but below LARGE_FILE_BYTES (100KB), so this
    // is gated by the per-type handler branch, not the earlier whole-file size branch.
    const p = makeTmpMultilineFileWithExt(60 * 1024, 'html')

    const whole = preReadHandler(readEvent(p))
    expect(whole.hookType).toBe('deny')

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))
    expect(sliced.hookType).not.toBe('deny')
  })

  it('allows a mid-size (10-100KB) .csv read when offset/limit narrows it to a small slice — exercises the universal file-type-handler branch (handleCsv), not just the top-level large-file gate', () => {
    // 20KB: above FILE_TYPE_THRESHOLDS.csv (10KB) but below LARGE_FILE_BYTES (100KB), so this
    // is gated by the per-type handler branch, not the earlier whole-file size branch.
    const p = makeTmpMultilineFileWithExt(20 * 1024, 'csv')

    const whole = preReadHandler(readEvent(p))
    expect(whole.hookType).toBe('deny')

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))
    expect(sliced.hookType).not.toBe('deny')
  })

  it('does not poison re-read dedup when a first read is denied for being too large (>500KB) — a retry sees the same deny, not "already read"', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))
    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('deny')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    const retry = preReadHandler(readEvent(p))
    expect(retry.hookType).toBe('deny')
    if (retry.hookType === 'deny') {
      expect(retry.message).toContain('is very large')
      expect(retry.message).not.toContain('already read this session')
    }
  })

  it('does not poison re-read dedup when a large CSV read is denied by the universal file-type handler', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.csv`)
    fs.writeFileSync(p, 'a,b\n' + 'x'.repeat(FILE_TYPE_THRESHOLDS.csv + 1000))
    tmpFiles.push(p)

    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('deny')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    const retry = preReadHandler(readEvent(p))
    expect(retry.hookType).toBe('deny')
    if (retry.hookType === 'deny') {
      expect(retry.message).not.toContain('already read this session')
    }
  })

  it('routes a CSV bigger than the generic large-file threshold (>100KB) to handleCsv, not the size-blind generic deny (regression: dispatch-order bug -- the generic gate fired first and pre-empted the CSV-specific advice)', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.csv`)
    const rows = ['id,name,status']
    let i = 0
    while (rows.join(`\n`).length < 150 * 1024) {
      rows.push(`${i},name-${i},active`)
      i++
    }
    fs.writeFileSync(p, rows.join(`\n`))
    tmpFiles.push(p)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('csv-query')
      expect(result.message).toContain('Columns:')
      expect(result.message).not.toContain('Consider token-goat skeleton or token-goat section')
    }
  })

  it('treats a 101KB unrecognized-extension file via the unified 100KB threshold (soft hint, not a hard block)', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.xyz`)
    fs.writeFileSync(p, 'x'.repeat(FILE_TYPE_THRESHOLDS.generic + 1000))
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    // Above FILE_TYPE_THRESHOLDS.generic (100,000) and, with the thresholds unified,
    // also above the large-file soft-hint boundary — so this should get the soft
    // "is large" context nudge from the large-file branch (checked first), not the
    // generic file-type handler's hard block that fired below the old, higher
    // 102,400-byte LARGE_FILE_BYTES boundary.
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
    }
  })

  it(
    'records a session_hint stat when the large-file soft hint is actually shown ' +
      '(control case for the quiet-hours over-count regression below)',
    () => {
      const before = summarize(30).by_kind['session_hint']?.events ?? 0

      const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.xyz`)
      fs.writeFileSync(p, 'x'.repeat(FILE_TYPE_THRESHOLDS.generic + 1000))
      tmpFiles.push(p)
      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('context')

      const after = summarize(30).by_kind['session_hint']?.events ?? 0
      expect(after).toBe(before + 1)
    },
  )

  describe('session_hint stat over-count regression (#large-file quiet-hours)', () => {
    afterEach(() => {
      invalidateConfigCache()
      vi.useRealTimers()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    it(
      'does not record a session_hint stat when the hint is silently suppressed during quiet hours ' +
        '(regression: recordStat fired unconditionally before the quiet-hours degrade, over-counting ' +
        'the ledger for a hint the caller never actually saw)',
      () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 23, 0))
        const cfg = defaultConfig()
        cfg.hints.quiet_hours = '22:00-06:00'
        saveConfig(cfg)
        invalidateConfigCache()

        const before = summarize(30).by_kind['session_hint']?.events ?? 0

        const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.xyz`)
        fs.writeFileSync(p, 'x'.repeat(FILE_TYPE_THRESHOLDS.generic + 1000))
        tmpFiles.push(p)
        const result = preReadHandler(readEvent(p))
        expect(result.hookType).toBe('pass')

        const after = summarize(30).by_kind['session_hint']?.events ?? 0
        expect(after).toBe(before)
      },
    )
  })

  describe('session_hint stat over-count regression (#count-based re-read dedup quiet-hours)', () => {
    afterEach(() => {
      invalidateConfigCache()
      vi.useRealTimers()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    })

    it(
      'records a session_hint stat for the already-read note outside quiet hours ' +
        '(control case for the regression below)',
      () => {
        const cfg = defaultConfig()
        cfg.hints.protect_recent_reads = 0
        cfg.hints.reread_deny = false
        saveConfig(cfg)
        invalidateConfigCache()

        const p = makeTmpFile()
        recordFileRead(normalizePath(p))

        const before = summarize(30).by_kind['session_hint']?.events ?? 0
        const result = preReadHandler(readEvent(p))
        expect(result.hookType).toBe('context')

        const after = summarize(30).by_kind['session_hint']?.events ?? 0
        expect(after).toBe(before + 1)
      },
    )

    it(
      'does not record a session_hint stat when the already-read note is silently suppressed ' +
        'during quiet hours (regression: recordStat fired unconditionally before the count-based ' +
        'dedup block protectedRead/reread_deny checks and before quietContextOutput internal ' +
        'quiet-hours degrade, over-counting the ledger for a note the caller never actually saw)',
      () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 23, 0))
        const cfg = defaultConfig()
        cfg.hints.protect_recent_reads = 0
        cfg.hints.reread_deny = false
        cfg.hints.quiet_hours = '22:00-06:00'
        saveConfig(cfg)
        invalidateConfigCache()

        const p = makeTmpFile()
        recordFileRead(normalizePath(p))

        const before = summarize(30).by_kind['session_hint']?.events ?? 0
        const result = preReadHandler(readEvent(p))
        expect(result.hookType).toBe('pass')

        const after = summarize(30).by_kind['session_hint']?.events ?? 0
        expect(after).toBe(before)
      },
    )
  })

  it('returns pass for a small, never-read file', () => {
    const p = makeTmpFile('small')
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('records the read on every call', () => {
    const p = makeTmpFile('small')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    preReadHandler(readEvent(p))
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)

    // A second call (now a re-read) still records, bumping the count.
    preReadHandler(readEvent(p))
    preReadHandler(readEvent(p))
    // Three handler calls => three recorded reads.
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
  })

  it('does not record when file_path is missing', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('blocks reads under node_modules/ with a deny output', () => {
    const result = preReadHandler(readEvent('/project/node_modules/lodash/index.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
      expect(result.message).toContain('npm ls')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('blocks reads under node_modules\\ (backslash) on all platforms', () => {
    const result = preReadHandler(readEvent('C:\\project\\node_modules\\react\\index.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('blocks node_modules paths case-insensitively on Windows', () => {
    if (process.platform !== 'win32') {
      // Covered regardless of platform by the case-insensitive-fs test below (#isNodeModulesPath foldPath fix)
      expect(true).toBe(true)
      return
    }
    const result = preReadHandler(readEvent('C:\\PROJECT\\NODE_MODULES\\foo.js'))
    expect(result.hookType).toBe('deny')
  })

  it('blocks node_modules paths case-insensitively on a case-insensitive filesystem regardless of platform (#isNodeModulesPath foldPath fix)', () => {
    // Regression: isNodeModulesPath used to gate its case fold on isWindows() instead of
    // isCaseInsensitiveFs(), so a case-insensitive filesystem on a non-Windows platform (e.g.
    // macOS, which is case-insensitive by default) never got its path folded and a
    // differently-cased node_modules segment slipped through undetected. Force a non-Windows
    // platform AND a forced case-insensitive-fs override at the same time: under the old
    // isWindows()-gated code this combination fails (isWindows() is false, so no fold happens),
    // proving the test actually exercises the bug rather than passing trivially on a real
    // Windows dev machine where isWindows() is already true.
    const realPlatform = process.platform
    const prevCaseEnv = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    try {
      const result = preReadHandler(readEvent('/project/NODE_MODULES/foo.js'))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('node_modules is typically noise')
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      if (prevCaseEnv === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevCaseEnv
    }
  })

  it('does not block paths with similar names outside node_modules', () => {
    const result = preReadHandler(readEvent('/project/my_node_modules_backup/file.js'))
    expect(result.hookType).toBe('pass')
  })

  it('also blocks Grep calls on node_modules paths', () => {
    const result = preReadHandler(grepEvent('/project/node_modules/package/file.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('resolves the real Grep tool schema field ("path", not "file_path") so the Grep registration actually gates instead of being a no-op', () => {
    const result = preReadHandler(grepPathEvent('/project/node_modules/package/file.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('passes through when a Grep call has neither "path" nor "file_path"', () => {
    const result = preReadHandler(grepPathEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('does not use the "path" fallback for the Read tool (Grep-scoped only)', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { path: '/project/node_modules/package/file.js' },
      sessionId: 'test',
      raw: {},
    }
    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('does not hard-deny repeated Grep calls scoped to the same directory with different patterns — Grep cost/relevance depends on the pattern, not just the path, so it is exempt from the count-based re-read dedup', () => {
    const dir = '/project/src/components'
    const grepWithPattern = (pattern: string): HookEvent => ({
      eventName: 'pre_tool_use',
      toolName: 'Grep',
      toolInput: { path: dir, pattern },
      sessionId: 'test',
      raw: {},
    })

    const r1 = preReadHandler(grepWithPattern('useEffect'))
    expect(r1.hookType).not.toBe('deny')

    const r2 = preReadHandler(grepWithPattern('useState'))
    expect(r2.hookType).not.toBe('deny')

    // Before the fix, this 3rd Grep call on the same directory hard-denied via the
    // count-based re-read dedup (reads >= 2), even though the pattern differs each time.
    const r3 = preReadHandler(grepWithPattern('useMemo'))
    expect(r3.hookType).not.toBe('deny')

    const r4 = preReadHandler(grepWithPattern('useCallback'))
    expect(r4.hookType).not.toBe('deny')
  })

  it('does not hard-deny a Grep call against a file at/above the large-file deny threshold (500KB) — Grep\'s cost depends on its search pattern, not the file\'s total size, same rationale as the count-based re-read exemption above (fail-on-buggy: the whole-file large-size gate had no Grep exemption, so estimateRequestedSlice()\'s unbounded result for Grep gated it on the full file size and hard-denied it with a nonsensical "edit it anyway" message)', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Grep',
      toolInput: { path: p, pattern: 'needle' },
      sessionId: 'test',
      raw: {},
    }

    const result = preReadHandler(event)
    expect(result.hookType).not.toBe('deny')
  })

  it('still hard-denies a whole-file Read against a file at/above the large-file deny threshold — the Grep size-gate exemption does not leak to Read', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  it('still hard-denies the 3rd+ Read call on the same path — the Grep exemption does not leak to Read', () => {
    pinProtectRecentReadsToZero()
    const dir = '/project/src/components'
    const r1 = preReadHandler(readEvent(dir))
    expect(r1.hookType).not.toBe('deny')

    const r2 = preReadHandler(readEvent(dir))
    expect(r2.hookType).not.toBe('deny')

    const r3 = preReadHandler(readEvent(dir))
    expect(r3.hookType).toBe('deny')
  })

  it('does not intercept a Grep call against a doc file with a fresh compact sidecar — Grep must search the live content, not receive the served compact instead of running the search', () => {
    const p = _makeTmpMdFile('# Title\n\nSome short doc content.\n')
    const compactPath = compactPathFor(p)
    writeCompact(compactPath, p, 'Title\nAn extractive summary of the doc.')

    const result = preReadHandler(grepPathEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('does not intercept a Grep call against a .ipynb notebook — Grep must search the live content, not the output-stripped sidecar', () => {
    const bigOutput = 'A'.repeat(6000)
    const nb = {
      cells: [
        {
          cell_type: 'code',
          source: ['print("hi")'],
          execution_count: 1,
          outputs: [{ output_type: 'stream', name: 'stdout', text: [bigOutput] }],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ipynb`)
    fs.writeFileSync(p, JSON.stringify(nb))
    tmpFiles.push(p)

    const result = preReadHandler(grepPathEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('does not intercept a Grep call against a large markdown file with >=3 headings — Grep must search, not receive the heading-tree hint in place of running the search', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(grepPathEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('denies 2nd read of any .md file regardless of size', () => {
    pinProtectRecentReadsToZero()
    const p = _makeTmpMdFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section')
      expect(result.message).not.toContain('skeleton')
      expect(result.message).not.toContain('read/section/symbol')
    }
  })

  it('gives a section-only large-file hint for .md files', () => {
    const p = _makeTmpMdFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).not.toContain('skeleton')
    }
  })

  it('gives a context hint (not a deny) on the first read of a large markdown file with >=3 headings', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Large markdown file')
      expect(result.context).toContain('# Title')
      expect(result.context).toContain('## Installation')
      expect(result.context).toContain('token-goat section')
    }
  })

  it('hard-denies a re-read of a large markdown file with >=3 headings', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
      expect(result.message).toContain('# Title')
      expect(result.message).toContain('## Installation')
      expect(result.message).toContain('token-goat section')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('hard-denies the FIRST read of a markdown file at/above the generic large-file deny threshold, even with >=3 headings (fail-on-buggy: the markdown branch previously let any first read through via contextOutput regardless of size, bypassing the 500KB deny every other file type gets)', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    // 500KB deny threshold at 'cool' pressure (largeFileDenyBytes() in hooks_read.ts, no session
    // cache here so getContextPressure() defaults to 'cool') — pad well past it.
    const p = _makeTmpMdFile(mdContent + 'x'.repeat(520 * 1024))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('a retry (offset/limit) on an oversized markdown file that was just denied on its first read still gets heading-tree guidance, not a "you already read this" 2nd-read deny (regression: recordActualRead() was called unconditionally before the deny check, so a genuinely-first-and-denied read got marked as read, and a subsequent retry fell through to the generic 2nd-read markdown deny instead of repeating the heading-tree message a genuinely-unread file should get)', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    // Same 500KB-plus fixture as the sibling "hard-denies the FIRST read" test above.
    const p = _makeTmpMdFile(mdContent + 'x'.repeat(520 * 1024))

    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('deny')
    if (first.hookType === 'deny') {
      expect(first.message).toContain('Large markdown file')
    }

    // This first-read deny must not have been recorded against re-read dedup: the read never
    // actually happened (it was blocked outright), unlike a genuine re-read.
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    // Simulate the retry with an offset/limit range, exactly as the caller is told to do.
    const retry = preReadHandler(readEventWithRange(p, 0, 50))
    expect(retry.hookType).toBe('deny')
    if (retry.hookType === 'deny') {
      // Heading-tree guidance again — not the generic "Markdown file already read this
      // session" 2nd-read deny, which would be wrong for a file that was never actually read.
      expect(retry.message).toContain('Large markdown file')
      expect(retry.message).toContain('# Title')
      expect(retry.message).not.toContain('Markdown file already read this session')
    }
  })

  it('serves a bounded offset/limit slice of an oversized markdown file instead of hard-denying it (regression: the markdown branch used to gate tooLargeForFirstRead on the whole file size regardless of offset/limit, unlike the generic large-file gate and file-type dispatcher, which both call estimateRequestedSlice() to let a small bounded window through)', () => {
    const headerLines = ['# Title', '## Installation', '### Quick Start']
    const fillerLine = 'This is filler body content padding out the file well past a single heading. '
    const fillerLines = Array.from({ length: 15000 }, (_, i) => fillerLine + i)
    const mdContent = [...headerLines, ...fillerLines].join('\n')
    const p = _makeTmpMdFile(mdContent)

    // Deep into the filler body (well past the 3 headings, which sit in the first 3 lines) —
    // "not cleanly under a single heading" — and a small enough window (25 lines) that its
    // estimated byte size is nowhere near the 500KB deny threshold, even though the whole
    // file (~850KB) is well above it.
    const result = preReadHandler(readEventWithRange(p, 5000, 25))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Large markdown file')
      expect(result.context).not.toContain('To edit it anyway')
    }
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
  })

  it('still hard-denies a whole-file (no offset/limit) first read of that same oversized markdown file — the bounded-slice carve-out does not weaken the unbounded case', () => {
    const headerLines = ['# Title', '## Installation', '### Quick Start']
    const fillerLine = 'This is filler body content padding out the file well past a single heading. '
    const fillerLines = Array.from({ length: 15000 }, (_, i) => fillerLine + i)
    const mdContent = [...headerLines, ...fillerLines].join('\n')
    const p = _makeTmpMdFile(mdContent)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
      expect(result.message).toContain('token-goat replace')
    }
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)
  })

  it('allows small markdown files to pass through even with headings', () => {
    const mdContent = `# Title
## Section
### Subsection`

    const p = _makeTmpMdFile(mdContent)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('allows large markdown files with <3 headings to pass through', () => {
    const mdContent = `# Title
Some content that makes the file large enough`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('intercepts .mdx files with same rules as .md, denying only on re-read', () => {
    const mdContent = `# React Component
## Props
### Configuration
## Examples`

    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.mdx`,
    )
    fs.writeFileSync(p, mdContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('context')
    if (first.hookType === 'context') {
      expect(first.context).toContain('Large markdown file')
    }

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
    }
  })

  it('includes well-known sections in the re-read deny output for README.md', () => {
    const readmeContent = `# My Project
## Installation
## Usage
## API
## Configuration
## Getting Started`

    const p = path.join(
      os.tmpdir(),
      `README.md`,
    )
    fs.writeFileSync(p, readmeContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Quick access:')
      expect(result.message).toContain('Installation')
      expect(result.message).toContain('Usage')
      expect(result.message).toContain('API')
    }
  })

  it('filters well-known sections down to headings that actually exist in the file (regression: dead-end hints)', () => {
    // WELL_KNOWN_SECTIONS['README.md'] hardcodes ['Install', 'Usage', 'API', 'Configuration',
    // 'Getting Started'], but this README only has 'Installation' (not an exact match for
    // 'Install') and 'License' (not in the hardcoded list at all). None of the hardcoded
    // sections should be suggested as `token-goat section` commands.
    const readmeContent = `# My Project
## Installation
## License`

    const p = path.join(os.tmpdir(), 'README.md')
    fs.writeFileSync(p, readmeContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      // The heading tree itself still lists the real headings.
      expect(result.message).toContain('Installation')
      expect(result.message).toContain('License')
      // None of the hardcoded, nonexistent well-known sections should appear as a
      // `token-goat section` suggestion.
      expect(result.message).not.toContain('::Install"')
      expect(result.message).not.toContain('::Usage"')
      expect(result.message).not.toContain('::API"')
      expect(result.message).not.toContain('::Configuration"')
      expect(result.message).not.toContain('::Getting Started"')
    }
  })

  it('gives context hint on 2nd read of a small file, deny on 3rd+', () => {
    pinProtectRecentReadsToZero()
    const p = makeTmpFile('x'.repeat(5 * 1024))

    // First read: pass (never read before)
    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')

    // Second read: context (readCount is 1 after first pass recorded it)
    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('context')

    // Third read: deny (readCount is now 2, so reads >= 2)
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('deny')
    if (r3.hookType === 'deny') {
      expect(r3.message).toContain('already read this session')
    }
  })

  it('does not count a Grep toward the Read-specific re-read counter, so a first real Read after two Greps on the same file still passes (regression: recordFileRead used to fire unconditionally in several branches even for Grep events, inflating the counter the Read-only deny check relies on)', () => {
    const p = makeTmpFile('x'.repeat(5 * 1024))

    // Two Greps on the same file. The count-based deny check explicitly exempts Grep, so
    // neither of these should feed the Read-specific read-count either.
    const g1 = preReadHandler(grepEvent(p))
    expect(g1.hookType).toBe('pass')
    const g2 = preReadHandler(grepEvent(p))
    expect(g2.hookType).toBe('pass')

    // First real Read of this file: must pass, not be denied as "already read this session".
    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')
  })

  it('counts a 3rd physical read as reads=2 even when it arrives under different path casing than the first-seen key (regression: the reread-count lookup used a direct getSessionFiles().get(normalized) instead of the case-fold-aware resolution recordFileRead/wasFileReadThisSession use, so a differently-cased 3rd read under-reported as reads=1 and returned "context" instead of "deny")', () => {
    const prevCaseEnv = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    try {
      // Vary only the basename's casing (keep the directory untouched) -- os.tmpdir() may
      // already be all-lowercase (e.g. Linux CI's "/tmp"), and resolveFilesKey's fold-scan is
      // only exercised when the queried string's own fold differs from itself, so uppercasing
      // just the basename reliably produces a "differently-cased" query on every platform.
      const p = makeTmpFile('x'.repeat(5 * 1024))
      const name = path.basename(p)
      const dir = path.dirname(p)
      const pUpper = path.join(dir, name.toUpperCase())
      const pTitle = path.join(dir, name.charAt(0).toUpperCase() + name.slice(1))

      // First read (first-seen casing): pass, records the _files key at this exact casing.
      const r1 = preReadHandler(readEvent(p))
      expect(r1.hookType).toBe('pass')

      // Second read under different casing: context (readCount is 1 after the first pass).
      const r2 = preReadHandler(readEvent(pUpper))
      expect(r2.hookType).toBe('context')

      // Third read under yet another casing: deny (readCount is now 2, so reads >= 2). Before
      // the fix this fell back to reads=1 and returned "context" because getSessionFiles().get()
      // missed the differently-cased key.
      const r3 = preReadHandler(readEvent(pTitle))
      expect(r3.hookType).toBe('deny')
      if (r3.hookType === 'deny') {
        expect(r3.message).toContain('already read this session (2 reads)')
      }
    } finally {
      if (prevCaseEnv === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevCaseEnv
    }
  })

  it('does not deny re-reads of an image via the generic re-read-dedup branch — the large-file-deny and universal-file-type branches already exempt isImagePath, but this third branch was missing the same exemption, so a same-size-or-larger image got a nonsensical "use token-goat read/section/symbol" deny on re-read', () => {
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.png`,
    )
    // 60KB: below LARGE_FILE_BYTES/FILE_TYPE_THRESHOLDS.generic (100KB) so neither of those
    // branches fires, but at/above REREAD_DENY_BYTES (50KB) so the size-based re-read deny in
    // the generic dedup branch would fire on an un-exempted 2nd read.
    fs.writeFileSync(p, Buffer.alloc(60 * 1024, 1))
    tmpFiles.push(p)

    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')

    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('pass')

    // reads >= 2 unconditionally denies in the un-exempted branch, regardless of size.
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('pass')
  })

  it('recognizes .cs as a source extension for the count-based re-read deny (regression: SOURCE_EXT_RE used to hand-maintain a duplicate of parser_types.ts\'s extension list and omitted .cs, .mjs/.cjs/.mts/.cts, .cc/.cxx/.hpp/.hxx, .kts, and .pyi despite each having a real tree-sitter adapter)', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.cs`,
    )
    fs.writeFileSync(p, 'class Foo {}')
    tmpFiles.push(p)

    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')
    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('context')

    // The source-ext count-based deny fires here (not the generic fallback), producing its
    // own distinct message pointing at token-goat read/skeleton/outline.
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('deny')
    if (r3.hookType === 'deny') {
      expect(r3.message).toContain('Read this file 2 times already')
      expect(r3.message).toContain('token-goat skeleton')
    }
  })

  it('recognizes .ps1/.psm1 (PowerShell) and .cls/.trigger (Apex) as source extensions for the count-based re-read deny (regression: SOURCE_EXT_RE/DIFFABLE_SOURCE_RE drifted from EXTENSION_LANGUAGE and omitted these despite real language adapters existing)', () => {
    pinProtectRecentReadsToZero()
    for (const suffix of ['.ps1', '.psm1', '.trigger']) {
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`,
      )
      fs.writeFileSync(p, suffix === '.trigger' ? 'trigger Example on Account (before insert) {}' : 'Write-Host "hi"')
      tmpFiles.push(p)

      expect(preReadHandler(readEvent(p)).hookType).toBe('pass')
      expect(preReadHandler(readEvent(p)).hookType).toBe('context')
      const third = preReadHandler(readEvent(p))
      expect(third.hookType).toBe('deny')
      if (third.hookType === 'deny') {
        expect(third.message).toContain('token-goat skeleton')
      }
    }
  })

  it('recognizes Salesforce source and metadata files for symbol-aware re-read guidance', () => {
    pinProtectRecentReadsToZero()
    for (const suffix of ['.cls', '.cmp', '.flow-meta.xml']) {
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`,
      )
      fs.writeFileSync(p, suffix === '.cls' ? 'public class Example {}' : '<Example/>')
      tmpFiles.push(p)

      expect(preReadHandler(readEvent(p)).hookType).toBe('pass')
      expect(preReadHandler(readEvent(p)).hookType).toBe('context')
      const third = preReadHandler(readEvent(p))
      expect(third.hookType).toBe('deny')
      if (third.hookType === 'deny') {
        expect(third.message).toContain('token-goat skeleton')
      }
    }
  })

  it('does not recognize .swift as a source extension for the count-based re-read deny (regression: .swift was hardcoded into SOURCE_EXT_RE despite parser_types.ts having no adapter for it, so a 3rd read produced the skeleton/outline-pointing deny message even though those commands would return nothing for a .swift file)', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.swift`,
    )
    fs.writeFileSync(p, 'struct Foo {}')
    tmpFiles.push(p)

    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')
    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('context')

    // Falls through to the generic re-read-dedup deny instead of the source-ext-specific one.
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('deny')
    if (r3.hookType === 'deny') {
      expect(r3.message).not.toContain('token-goat skeleton')
      expect(r3.message).toContain('already read this session')
    }
  })

  // Count-based deny: 3rd+ read of source files (Item 1 — nestpilot mining)
  it('passes first read of a .ts source file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(p, 'export function foo() {}')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('gives context hint on 2nd read of a small .ts source file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(p, 'export function foo() {}')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
  })

  it('hard-denies 3rd read of a small .ts source file with count-based message', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(p, 'export function foo() {}')
    tmpFiles.push(p)
    // Simulate 2 prior reads
    recordFileRead(normalizePath(p))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Read this file')
      expect(result.message).toContain('times already')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('token-goat outline')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('hard-denies 4th read of a .tsx source file', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.tsx`)
    fs.writeFileSync(p, 'export const App = () => <div/>')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    recordFileRead(normalizePath(p))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat skeleton')
    }
  })

  it('does NOT apply count-based deny to .txt files (not a source extension)', () => {
    // .txt uses the existing generic logic, which emits context on 2nd read when small
    const p = makeTmpFile('plain text')
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    // Should be context (small file, 2nd read) — NOT the count-based deny
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).not.toContain('Read this file')
    }
  })

  it('denies re-read of .env file after first read', () => {
    const p = path.join(os.tmpdir(), `.env`)
    fs.writeFileSync(p, 'SECRET=abc\nOTHER=xyz\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('config-get')
    }
  })

  it('denies re-read of .env.local after first read', () => {
    const p = path.join(os.tmpdir(), `.env.local`)
    fs.writeFileSync(p, 'SECRET=abc\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('config-get')
    }
  })

  it('includes CHANGELOG version hint for large CHANGELOG.md files', () => {
    const changelogContent = `# Changelog

## [Unreleased]

## [2.1.0] - 2024-06-01

### Added
- New feature

## [2.0.0] - 2024-01-01`

    const p = path.join(
      os.tmpdir(),
      `CHANGELOG.md`,
    )
    fs.writeFileSync(p, changelogContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('[2.1.0]')
      expect(result.message).toContain('token-goat section')
    }
  })

  // Item 1: post-read truncation detection
  it('postReadHandler marks a file as truncated when response contains [Truncated:', () => {
    // hints.truncated_read_min_lines gates this deny (default 200); this fixture is a
    // 1-line file, so lower the threshold to 0 to keep exercising the deny path itself.
    const cfg = defaultConfig()
    cfg.hints.protect_recent_reads = 0
    cfg.hints.truncated_read_min_lines = 0
    saveConfig(cfg)
    invalidateConfigCache()

    const p = makeTmpFile('some content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'content here [Truncated: file too large, showing first 33K tokens]' },
    }
    postReadHandler(postEvent)

    // Next pre-read should be denied with skeleton hint
    const result = preReadHandler(readEvent(p))
    invalidateConfigCache()
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ok -- may not exist
    }
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('truncated on last read')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('postReadHandler marks file truncated on PARTIAL view marker', () => {
    const cfg = defaultConfig()
    cfg.hints.protect_recent_reads = 0
    cfg.hints.truncated_read_min_lines = 0
    saveConfig(cfg)
    invalidateConfigCache()

    const p = makeTmpFile('content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'first chunk Truncated: PARTIAL view of file' },
    }
    postReadHandler(postEvent)
    const result = preReadHandler(readEvent(p))
    invalidateConfigCache()
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ok -- may not exist
    }
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('truncated on last read')
    }
  })

  it('postReadHandler does not mark file truncated when response has no marker', () => {
    const p = makeTmpFile('content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'complete content with no truncation marker' },
    }
    postReadHandler(postEvent)
    // First pre-read should pass (not yet read)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Item 2: all .md/.mdx files denied on 2nd+ read regardless of size
  it('denies 2nd read of a large .md file', () => {
    pinProtectRecentReadsToZero()
    const p = _makeTmpMdFile('# Title\n\ncontent\n'.padEnd(15 * 1024, 'x'))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies 2nd read of a small .md file', () => {
    pinProtectRecentReadsToZero()
    const p = _makeTmpMdFile('# Small\ncontent')
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies 2nd read of a .mdx file', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.mdx`)
    fs.writeFileSync(p, '# Component\n\ncontent\n'.padEnd(15 * 1024, 'x'))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
    }
  })

  it('denies 2nd read of a .markdown file (M16: re-read-denial regex previously only matched .md/.mdx)', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.markdown`)
    fs.writeFileSync(p, '# Small\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
    }
  })

  it('denies 2nd read of a .rst file with no snapshot (falls through to the markdown re-read denial)', () => {
    pinProtectRecentReadsToZero()
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.rst`)
    fs.writeFileSync(p, 'Title\n=====\n\nSmall.\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Markdown file already read this session')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('postReadHandler stores a snapshot for .markdown files (m5: snapshot-storage regex previously excluded .markdown)', () => {
    const content = '# Doc\n\nContent.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.markdown`,
    )
    fs.writeFileSync(p, content)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    postReadHandler(postEvent)

    const snap = snapshotLoad(getSessionId(), normalizePath(p))
    expect(snap).not.toBeNull()
    expect(snap?.toString('utf8')).toBe(content)
  })

  // Item 5: .improve-state-*.json re-read denial
  it('denies 2nd read of .improve-state-*.json', () => {
    const p = path.join(os.tmpdir(), '.improve-state-bugfixing.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'bugfixing' }))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Orchestrator state already read')
    }
  })

  it('points the .improve-state-*.json re-read deny at a remedy that actually works — hooks_bash.ts exempts these files from every bash-output extraction site (isOrchestratorStateFile), so a bare `bash-output <id>` can never resolve to a cached entry', () => {
    const p = path.join(os.tmpdir(), '.improve-state-bugfixing.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'bugfixing' }))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "' + normalizePath(p) + '"')
      expect(result.message).not.toContain('bash-output <id>')
    }
  })

  it('passes first read of .improve-state-*.json', () => {
    const p = path.join(os.tmpdir(), '.improve-state-foo.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'foo' }))
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Item 8: MEMORY.md re-read denial
  it('denies 2nd read of memory/MEMORY.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Memory\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('MEMORY.md was read this session')
      expect(result.message).toContain('compact manifest')
    }
  })

  it('passes first read of memory/MEMORY.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem2-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Memory\ncontent')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('denies 2nd read of any .md file under memory/ directory', () => {
    const dir = path.join(os.tmpdir(), `tg-mem3-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'project_findings.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Findings\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('passes first read of memory/project_findings.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem4-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'project_findings.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Findings\ncontent')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Doc-file auto-diff on re-read
  it('injects diff in deny when .md file content changed since last read', () => {
    withMinTokensSaved(0, () => {
      const content1 = '# Title\n\nOriginal content here.\n'
      const content2 = '# Title\n\nOriginal content here.\n\n## New Section\n\nAdded content.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
      )
      fs.writeFileSync(p, content1)
      tmpFiles.push(p)

      // Simulate a successful Read: postReadHandler stores the snapshot
      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content1 },
      }
      postReadHandler(postEvent)
      recordFileRead(normalizePath(p))

      // File changes between reads
      fs.writeFileSync(p, content2)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('Content changed since last read')
        expect(result.message).toContain('```diff')
        expect(result.message).toContain('New Section')
        expect(result.message).toContain('token-goat section')
      }
    })
  })

  it('returns unchanged deny when .md file content is same as at last read', () => {
    pinProtectRecentReadsToZero()
    const content = '# Title\n\nSome content.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
    )
    fs.writeFileSync(p, content)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    postReadHandler(postEvent)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('unchanged since last read')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('injects diff for .rst file that changed since last read', () => {
    withMinTokensSaved(0, () => {
      const content1 = 'Title\n=====\n\nOriginal.\n'
      const content2 = 'Title\n=====\n\nOriginal.\n\nNew Section\n-----------\n\nAdded.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.rst`,
      )
      fs.writeFileSync(p, content1)
      tmpFiles.push(p)

      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content1 },
      }
      postReadHandler(postEvent)
      recordFileRead(normalizePath(p))

      fs.writeFileSync(p, content2)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('Content changed since last read')
        expect(result.message).toContain('```diff')
      }
    })
  })

  it('injects diff for .markdown file that changed since last read (isDocDiffable regex previously excluded .markdown, unlike its sibling regexes, so a changed .markdown fell through to the generic "already read" deny instead of serving the diff)', () => {
    withMinTokensSaved(0, () => {
      const content1 = 'Title\n=====\n\nOriginal.\n'
      const content2 = 'Title\n=====\n\nOriginal.\n\nNew Section\n-----------\n\nAdded.\n'
      const p = path.join(
        os.tmpdir(),
        `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.markdown`,
      )
      fs.writeFileSync(p, content1)
      tmpFiles.push(p)

      const postEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: p },
        sessionId: 'test',
        raw: { tool_response: content1 },
      }
      postReadHandler(postEvent)
      recordFileRead(normalizePath(p))

      fs.writeFileSync(p, content2)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('Content changed since last read')
        expect(result.message).toContain('```diff')
      }
    })
  })

  it('postReadHandler stores snapshot for .md files (enables future diff)', () => {
    const content = '# Doc\n\nContent.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
    )
    fs.writeFileSync(p, content)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    // postReadHandler should complete without throwing
    expect(() => postReadHandler(postEvent)).not.toThrow()
  })

  // Source-file auto-diff on re-read (gated by serve_diff_on_reread) Helper: run a fn with the flag forced on/off, restoring the prior value.
  function withDiffFlag<T>(on: boolean, fn: () => T): T {
    const oldEnv = process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD
    if (on) process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD = '1'
    else delete process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD
    try {
      return fn()
    } finally {
      if (oldEnv === undefined) delete process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD
      else process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD = oldEnv
    }
  }

  // hints.diff_hint_min_tokens_saved has no env-var override (unlike most hints fields), so
  // tests drive it the same way as the reread_deny wiring tests above: write a temp config.toml
  // (configPath() is mocked to _testConfigPath at the top of this file) and invalidate the cache.
  function withMinTokensSaved<T>(tokensSaved: number, fn: () => T): T {
    const cfg = defaultConfig()
    cfg.hints.protect_recent_reads = 0
    cfg.hints.diff_hint_min_tokens_saved = tokensSaved
    saveConfig(cfg)
    invalidateConfigCache()
    try {
      return fn()
    } finally {
      invalidateConfigCache()
      try {
        fs.unlinkSync(_testConfigPath)
      } catch {
        // ok -- may not exist
      }
    }
  }

  // Build a multi-line source file large enough that a 1-line change diffs well under the savings cap.
  function bigSource(varValue: number): string {
    const lines = Array.from({ length: 30 }, (_, i) => `  const x${i} = ${i === 5 ? varValue : i}`).join('\n')
    return `export function big() {\n${lines}\n  return 0\n}\n`
  }

  function tmpFileExt(content: string, ext: string): string {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`)
    fs.writeFileSync(p, content)
    tmpFiles.push(p)
    return p
  }

  function snapshotFirstRead(p: string, content: string): void {
    postReadHandler({
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    })
    recordFileRead(normalizePath(p))
  }

  it('flag ON: serves a diff (with symbol hint) on re-read of a changed .tsx', () => {
    withDiffFlag(true, () => {
      withMinTokensSaved(0, () => {
        const content1 = bigSource(5)
        const p = tmpFileExt(content1, '.tsx')
        snapshotFirstRead(p, content1)
        fs.writeFileSync(p, bigSource(555)) // one line changed

        const result = preReadHandler(readEvent(p))
        expect(result.hookType).toBe('deny')
        if (result.hookType === 'deny') {
          expect(result.message).toContain('Content changed since last read')
          expect(result.message).toContain('```diff')
          // Real unified-diff body, not just a substring of the new content.
          expect(result.message).toContain('-  const x5 = 5')
          expect(result.message).toContain('+  const x5 = 555')
          // .tsx is symbol-style: hint must point to `token-goat read ::Symbol`, not section
          expect(result.message).toContain('token-goat read')
        }
      })
    })
  })

  it('flag ON: hints.diff_hint_min_tokens_saved suppresses a diff that saves fewer tokens than the configured floor (regression: field had zero consumers)', () => {
    withDiffFlag(true, () => {
      withMinTokensSaved(100_000, () => {
        const content1 = bigSource(5)
        const p = tmpFileExt(content1, '.tsx')
        snapshotFirstRead(p, content1)
        fs.writeFileSync(p, bigSource(555)) // one line changed -- tiny real savings

        const result = preReadHandler(readEvent(p))
        // Same fixture that serves a diff at the default/zero floor above must NOT serve one
        // once the floor is set far above what this tiny change actually saves.
        expect(result.message ?? '').not.toContain('```diff')
      })
    })
  })

  it('flag ON: serves "unchanged" with a section hint on re-read of an unchanged .css', () => {
    pinProtectRecentReadsToZero()
    withDiffFlag(true, () => {
      const content = '.hero {\n  color: red;\n}\n.footer {\n  color: blue;\n}\n'
      const p = tmpFileExt(content, '.css')
      snapshotFirstRead(p, content)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
        // .css is section-style
        expect(result.message).toContain('token-goat section')
      }
    })
  })

  it('flag OFF (default): re-read of a changed .tsx serves NO diff (preserves deny behavior)', () => {
    withDiffFlag(false, () => {
      const content1 = bigSource(5)
      const p = tmpFileExt(content1, '.tsx')
      snapshotFirstRead(p, content1) // flag off → no snapshot stored for .tsx
      fs.writeFileSync(p, bigSource(555))

      const result = preReadHandler(readEvent(p))
      // No diff is ever served when the flag is off — this is the key default-unchanged regression.
      expect(result.message ?? '').not.toContain('```diff')
    })
  })

  it('flag ON: savings guard — a minified single-line .json change falls through to deny (no diff)', () => {
    withDiffFlag(true, () => {
      const pairs1 = Array.from({ length: 40 }, (_, i) => `"k${i}":"v${i}"`).join(',')
      const pairs2 = Array.from({ length: 40 }, (_, i) => `"k${i}":"${i === 20 ? 'CHANGED' : 'v' + i}"`).join(',')
      const content1 = `{${pairs1}}`
      const content2 = `{${pairs2}}`
      const p = tmpFileExt(content1, '.json')
      snapshotFirstRead(p, content1)
      fs.writeFileSync(p, content2)

      const result = preReadHandler(readEvent(p))
      // Single-line file: the "diff" is ~2x the file, exceeding the 0.6 savings cap, so no diff is served.
      expect(result.message ?? '').not.toContain('```diff')
    })
  })

  it('flag ON: .yaml (in DIFFABLE_SOURCE_RE) gets the section-style hint on unchanged re-read', () => {
    pinProtectRecentReadsToZero()
    withDiffFlag(true, () => {
      const content = 'name: app\nversion: 1\nsteps:\n  - build\n  - test\n'
      const p = tmpFileExt(content, '.yaml')
      snapshotFirstRead(p, content)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
        // .yaml is section-style, not symbol-style
        expect(result.message).toContain('token-goat section')
        expect(result.message).not.toContain('token-goat read')
      }
    })
  })

  // Post-read structural-navigation hint (post_read_code_compress.min_lines): once a
  // just-read source file crosses the line-count threshold (default 200), postReadHandler
  // should nudge toward token-goat skeleton/outline instead of a future full re-read.
  function makeLineCountedSource(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, i) => `const x${i} = ${i}`).join('\n') + '\n'
  }

  it('postReadHandler emits a skeleton/outline hint when a read source file is >= post_read_code_compress.min_lines', () => {
    const content = makeLineCountedSource(200)
    const p = tmpFileExt(content, '.ts')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }

    const result = postReadHandler(postEvent)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat skeleton')
      expect(result.context).toContain('token-goat outline')
      expect(result.context).toContain(normalizePath(p))
    }
  })

  it('postReadHandler does not emit the skeleton/outline hint below post_read_code_compress.min_lines', () => {
    const content = makeLineCountedSource(199)
    const p = tmpFileExt(content, '.ts')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }

    const result = postReadHandler(postEvent)
    expect(result.hookType).toBe('pass')
  })

  it('postReadHandler does not emit the skeleton/outline hint for a non-source file, even well past the line threshold', () => {
    const content = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const p = tmpFileExt(content, '.md')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }

    const result = postReadHandler(postEvent)
    expect(result.hookType).toBe('pass')
  })

})

describe('preReadHandler — session artifact re-read dedup', () => {
  function makeTasksOutputFile(content = 'task output data'): string {
    const sessionDir = path.join(os.tmpdir(), `tg-session-${process.pid}-${Math.random().toString(36).slice(2)}`)
    const tasksDir = path.join(sessionDir, 'tasks')
    fs.mkdirSync(tasksDir, { recursive: true })
    const p = path.join(tasksDir, 'w9lh32xe0.output')
    fs.writeFileSync(p, content)
    tmpFiles.push(p)
    return p
  }

  it('emits a runnable --file recall hint on first read of tasks/*.output', () => {
    const p = makeTasksOutputFile()
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      // Must name a runnable command — bash-output --file "<path>" — not the old bare `--tail N` placeholder, which errors with "provide an <id> or --file".
      expect(result.context).toContain('token-goat bash-output --file "' + normalizePath(p) + '"')
      expect(result.context).toContain('--tail 50')
      expect(result.context).toContain('--grep')
      expect(result.context).not.toContain('--tail N')
    }
  })

  it('denies (does not pass) a large first read of tasks/*.output instead of dumping it unsized (regression: 57,920-byte first read previously went through as a bare advisory hint)', () => {
    const p = makeTasksOutputFile('x'.repeat(25 * 1024)) // above TASK_OUTPUT_DENY_BYTES (20KB)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "' + normalizePath(p) + '"')
      expect(result.message).toContain('--tail 50')
    }
  })

  it('denies re-read of tasks/*.output when content unchanged since last read', () => {
    const content = 'task output data\nline two\n'
    const p = makeTasksOutputFile(content)
    const normalized = normalizePath(p)

    // Simulate: first read (context output fires, then postReadHandler captures snapshot)
    preReadHandler(readEvent(p))
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    postReadHandler(postEvent)
    recordFileRead(normalized)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('unchanged since last read')
      expect(result.message).toContain('token-goat bash-output --file "' + normalized + '"')
      expect(result.message).not.toContain('--tail N')
    }
  })

  it('injects diff in deny when tasks/*.output content changed since last read', () => {
    const content1 = 'task output line 1\ntask output line 2\n'
    const content2 = 'task output line 1\ntask output line 2\ntask output line 3 (added)\n'
    const p = makeTasksOutputFile(content1)
    const normalized = normalizePath(p)

    preReadHandler(readEvent(p))
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content1 },
    }
    postReadHandler(postEvent)
    recordFileRead(normalized)

    fs.writeFileSync(p, content2)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Content changed since last read')
      expect(result.message).toContain('```diff')
      expect(result.message).toContain('token-goat bash-output --file "' + normalized + '"')
    }
  })
})

describe('preReadHandler - skill stale compact advisory', () => {
  const rnd = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const skillsRoot = path.join(os.tmpdir(), `tg-skilladv-${rnd}`)
  const outputsDir = path.join(os.tmpdir(), `tg-skilladv-out-${rnd}`)
  const skillMd = path.join(skillsRoot, '.claude', 'skills', 'advskill', 'SKILL.md')

  beforeEach(() => {
    fs.mkdirSync(path.dirname(skillMd), { recursive: true })
    fs.mkdirSync(outputsDir, { recursive: true })
    setSkillOutputsDirForTesting(outputsDir)
  })

  afterEach(() => {
    setSkillOutputsDirForTesting(null)
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(outputsDir, { recursive: true, force: true })
  })

  // Drives the real preReadHandler through the stale branch (no injected seam): a cached compact whose embedded source_sha != the body sha must yield the hint.
  it('emits a skill-compact hint when the cached compact is stale', async () => {
    fs.writeFileSync(skillMd, '# Adv Skill\n\nbody content here\n')
    await storeCompact('default', 'advskill', 'compact slice', 'deadbeefcafe')
    const result = preReadHandler(readEvent(skillMd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('skill-compact advskill')
    }
  })

  it('does not emit the hint when the compact sha matches the body', async () => {
    const body = '# Adv Skill\n\nfresh body\n'
    fs.writeFileSync(skillMd, body)
    await storeCompact('default', 'advskill', 'compact slice', contentHash(body).slice(0, 12))
    const result = preReadHandler(readEvent(skillMd))
    const text = result.hookType === 'context' ? result.context : ''
    expect(text).not.toContain('skill-compact advskill')
  })
})

describe('buildLineDiff', () => {
  it('hunk header counts match the untruncated body exactly (control)', () => {
    const oldContent = 'a\nb\nc\n'
    const newContent = 'a\nX\nY\nc\n'
    const diff = buildLineDiff(oldContent, newContent, 'f.ts')
    const header = diff.split('\n').find((l) => l.startsWith('@@'))
    expect(header).toBe('@@ -2,1 +2,2 @@')
    const removedShown = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    const addedShown = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    expect(removedShown).toBe(1)
    expect(addedShown).toBe(2)
  })

  it('hunk header counts reflect the truncated body, not the pre-truncation totals (regression: header overstated line counts on large diffs)', () => {
    // 40 removed lines + 40 added lines = 80 changed lines, well over MAX_LINES (50), so
    // the body truncates. Before the fix, the header still claimed the full pre-truncation
    // counts (-x,40 +x,40) while the body itself only ever shows 50 lines total.
    const oldLines = Array.from({ length: 40 }, (_, i) => `old${i}`)
    const newLines = Array.from({ length: 40 }, (_, i) => `new${i}`)
    const oldContent = oldLines.join('\n')
    const newContent = newLines.join('\n')
    const diff = buildLineDiff(oldContent, newContent, 'big.ts')
    const header = diff.split('\n').find((l) => l.startsWith('@@'))
    expect(header).toBeDefined()
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header ?? '')
    expect(match).not.toBeNull()
    const headerOldCount = Number(match?.[2])
    const headerNewCount = Number(match?.[4])

    const removedShown = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    const addedShown = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && !l.startsWith('... (')).length

    // The header must describe exactly what the body shows, and the body is capped at 50
    // total changed lines (all 40 removed + only 10 of the 40 added, since removed lines
    // are emitted first).
    expect(headerOldCount).toBe(removedShown)
    expect(headerNewCount).toBe(addedShown)
    expect(headerOldCount).toBe(40)
    expect(headerNewCount).toBe(10)
    expect(diff).toContain('more changed lines')
  })
})

describe('preReadHandler package.json manifest hint (regression: repeated identical hint on every read)', () => {
  it('emits the manifest hint on the first whole-file read of package.json', () => {
    const p = makeTmpFileNamed('package.json')
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    expect(result.hookType === 'context' && result.context).toContain('package manifest')
  })

  it('does not re-emit the identical manifest hint on a second read — falls through to the existing manifest re-read hint instead', () => {
    const p = makeTmpFileNamed('package.json')
    const first = preReadHandler(readEvent(p))
    expect(first.hookType === 'context' && first.context).toContain('package manifest')

    const second = preReadHandler(readEvent(p))
    expect(second.hookType).toBe('context')
    const secondText = second.hookType === 'context' ? second.context : ''
    // Must not be the same manifest-hint text repeated verbatim.
    expect(secondText).not.toContain('package manifest')
    // Falls through to the existing generic "already read this manifest" hint.
    expect(secondText).toContain('already read')
  })
})
