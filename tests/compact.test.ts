/** Tests for compact.ts functions. */

import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — this redirects configPath() to a per-test temp file so the getEffectiveAutoTriggerWindow regression test below can write a real config.toml without touching the machine's real config file.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    projectConfigPath: () => _testProjectConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-compact-test-config.toml')
const _testProjectConfigPath = tempConfigPath('tg-compact-test-project-config.toml')

import {
  CATALOG_TOKENS,
  CONTEXT_AUTOCOMPACT_TOKENS,
  CONTEXT_TIER_CRITICAL,
  CONTEXT_TIER_HOT,
  CONTEXT_TIER_WARM,
  computeAdaptiveBudget,
  estimateTokens,
  eventCount,
  findLatestSessionId,
  getAutoTriggerMultiplier,
  getContextPressure,
  isNoisePath,
  loadSessionCache,
  measurePromptTokens,
  normalizeForCache,
  tierForFraction,
  type SessionCacheObject,
} from '../src/compact.js'
import { buildManifest } from '../src/manifest.js'
import { findProject } from '../src/project.js'
import { setEntry } from '../src/project_memory.js'
import { invalidateConfigCache } from '../src/config.js'
import { storeBlob } from '../src/disk_cache.js'
import { saveSessionState, SESSIONS_SUBDIR } from '../src/session_store.js'
import { importSessionState, recordBashOutput, recordFileEdit, recordFileRead, recordWebFetch, type FileEntry } from '../src/session.js'
import { postBashHandler } from '../src/hooks_bash.js'
import { makeHookEvent } from './helpers/hook-event.js'

/** Build a minimal {@link FileEntry} for SessionCacheObject.files fixtures. */
function fileEntry(p: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path: p, readCount: 1, lastReadAt: 0, wasEdited: false, sizeBytes: 0, ...overrides }
}

/** Reset session.ts's in-memory singleton so tests don't bleed state into each other. */
function resetSessionState(): void {
  importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
}

describe('compact', () => {
  describe('estimateTokens', () => {
    it('estimates tokens as roughly length/3 + 1', () => {
      expect(estimateTokens('abc')).toBe(2) // 3/3 + 1 = 2
      expect(estimateTokens('abcdef')).toBe(3) // 6/3 + 1 = 3
      expect(estimateTokens('')).toBe(1) // min 1
    })

    it('rounds down when dividing', () => {
      expect(estimateTokens('ab')).toBe(1) // 2/3 = 0, + 1 = 1
      expect(estimateTokens('abcd')).toBe(2) // 4/3 = 1, + 1 = 2
    })

    it('strips ANSI color codes before counting, matching overflow_guard.ts', () => {
      const plain = 'abcdefghij'
      const colored = `\x1b[31m${plain}\x1b[0m`
      // Without stripping, the escape sequences would inflate the estimate well past the plain-text count.
      expect(estimateTokens(colored)).toBe(estimateTokens(plain))
    })
  })

  describe('tierForFraction', () => {
    it('returns "cool" below 0.50', () => {
      expect(tierForFraction(0.0)).toBe('cool')
      expect(tierForFraction(0.49)).toBe('cool')
    })

    it('returns "warm" from 0.50 to <0.70', () => {
      expect(tierForFraction(CONTEXT_TIER_WARM)).toBe('warm')
      expect(tierForFraction(0.60)).toBe('warm')
      expect(tierForFraction(0.69)).toBe('warm')
    })

    it('returns "hot" from 0.70 to <0.85', () => {
      expect(tierForFraction(CONTEXT_TIER_HOT)).toBe('hot')
      expect(tierForFraction(0.75)).toBe('hot')
      expect(tierForFraction(0.84)).toBe('hot')
    })

    it('returns "critical" at or above 0.85', () => {
      expect(tierForFraction(CONTEXT_TIER_CRITICAL)).toBe('critical')
      expect(tierForFraction(1.0)).toBe('critical')
      expect(tierForFraction(1.5)).toBe('critical')
    })
  })

  describe('getContextPressure', () => {
    // Pin harness detection so these assertions don't depend on the ambient environment the test runner happens to execute in ('generic''s multiplier is 1.0, matching CONTEXT_AUTOCOMPACT_TOKENS unscaled -- keeps every existing expected-value formula below unchanged).
    let savedHarnessOverride: string | undefined
    beforeEach(() => {
      savedHarnessOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
    })
    afterEach(() => {
      if (savedHarnessOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarnessOverride
    })

    it('returns cool pressure with no cache', () => {
      const pressure = getContextPressure()
      expect(pressure.fillFraction).toBe(0.0)
      expect(pressure.tier).toBe('cool')
    })

    it('computes pressure from the fabricated estimate when no transcript measurement is available', () => {
      const cache: SessionCacheObject = {
        loadedSkillTotalTokens: 0,
        bashOutputs: [['cmd1', 'out1'], ['cmd2', 'out2']],
        webFetches: [['url1', 'out1']],
        files: [fileEntry('a.ts'), fileEntry('b.ts'), fileEntry('c.ts')],
      }
      const pressure = getContextPressure(cache)
      const expected =
        (CATALOG_TOKENS + 2 * 500 + 1 * 1_000 + 3 * 200) / CONTEXT_AUTOCOMPACT_TOKENS
      expect(pressure.fillFraction).toBeCloseTo(expected, 5)
    })

    // Real transcript JSONL lines captured from Claude Code 2.1.270 (tests/fixtures/transcript_usage_capture.jsonl, PROVENANCE: CAPTURE). Regression for the defect this fix closes: pressureRawTotal used to fabricate a total from cumulative tool-call counts that only grows and never reflects a real compaction. This drives the real measurePromptTokens -> getContextPressure path against that fixture and asserts the result is NOT what the fabricated estimate would have produced for the same cache -- the assertion that would have caught the defect.
    it('prefers the transcript measurement over the fabricated estimate, and the two disagree', () => {
      const transcriptPath = path.join(__dirname, 'fixtures', 'transcript_usage_capture.jsonl')
      const cache: SessionCacheObject = {
        loadedSkillTotalTokens: 0,
        bashOutputs: [['cmd1', 'out1'], ['cmd2', 'out2']],
        webFetches: [['url1', 'out1']],
        files: [fileEntry('a.ts'), fileEntry('b.ts'), fileEntry('c.ts')],
      }
      const measured = getContextPressure(cache, transcriptPath)
      const estimated = getContextPressure(cache)
      // Last usage record in the fixture: input_tokens 2 + cache_creation_input_tokens 1338 + cache_read_input_tokens 119046 + output_tokens 333 = 120719.
      const expectedMeasuredTotal = 120719
      expect(measured.fillFraction).toBeCloseTo(expectedMeasuredTotal / CONTEXT_AUTOCOMPACT_TOKENS, 5)
      expect(measured.fillFraction).not.toBeCloseTo(estimated.fillFraction, 5)
    })

    it('falls back to the estimate when the transcript path does not resolve to a file', () => {
      const cache: SessionCacheObject = {
        loadedSkillTotalTokens: 0,
        bashOutputs: [['cmd1', 'out1'], ['cmd2', 'out2']],
        webFetches: [['url1', 'out1']],
        files: [fileEntry('a.ts'), fileEntry('b.ts'), fileEntry('c.ts')],
      }
      const pressure = getContextPressure(cache, path.join(__dirname, 'fixtures', 'does-not-exist.jsonl'))
      const expected =
        (CATALOG_TOKENS + 2 * 500 + 1 * 1_000 + 3 * 200) / CONTEXT_AUTOCOMPACT_TOKENS
      expect(pressure.fillFraction).toBeCloseTo(expected, 5)
    })

    // Regression: SessionCacheObject.bashHistory/webHistory used to be a placeholder Record<string, unknown> shape no writer ever populated. The real on-disk shape (session_store.ts::SerializedSession.webFetches/bashOutputs, and the _webFetches/_bashOutputs maps in session.ts) is an array of [key, id] pairs. This drives the real save -> load -> getContextPressure pipeline end to end so it fails against a reader that still expects the old bashHistory/webHistory dict shape and passes once loadSessionCache forwards the real fields.
    it('reflects real recorded bash/web activity loaded from disk (not just a hand-built cache object)', () => {
      const prevHome = process.env['TOKEN_GOAT_HOME']
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compact-pressure-'))
      process.env['TOKEN_GOAT_HOME'] = tmpHome
      resetSessionState()
      try {
        recordBashOutput('hash1', 'out1', 10)
        recordBashOutput('hash2', 'out2', 10)
        recordWebFetch('https://example.com', 'prompt', 'wout1')
        saveSessionState('pressure-real-session')

        const cache = loadSessionCache('pressure-real-session')
        expect(cache).not.toBeNull()
        const pressure = getContextPressure(cache ?? undefined)
        const expected = (CATALOG_TOKENS + 2 * 500 + 1 * 1_000) / CONTEXT_AUTOCOMPACT_TOKENS
        expect(pressure.fillFraction).toBeCloseTo(expected, 5)
      } finally {
        resetSessionState()
        if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
        else process.env['TOKEN_GOAT_HOME'] = prevHome
        try {
          fs.rmSync(tmpHome, { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
    })

    // Regression: getAutoTriggerMultiplier() computed a real harness-tuned multiplier but getContextPressure's window was CONTEXT_AUTOCOMPACT_TOKENS unscaled, so the multiplier had zero production callers. This drives the real pressure-computing path against a harness whose default multiplier (3.0) differs from 'generic''s (1.0), so it fails against a reader that still ignores the multiplier and passes once the window is scaled by it.
    it('scales the pressure window by the detected harness multiplier', () => {
      process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'gemini'
      const cache = {
        loadedSkillTotalTokens: 100,
      }
      const pressure = getContextPressure(cache)
      const expected = (100 + CATALOG_TOKENS) / (CONTEXT_AUTOCOMPACT_TOKENS * 3.0)
      expect(pressure.fillFraction).toBeCloseTo(expected, 5)
    })

    // Regression: getEffectiveAutoTriggerWindow() called getAutoTriggerMultiplier() without passing isConfigDefault, so that function fell back to a heuristic (isDefault = config === 2.0) that can't tell "user explicitly wrote 2.0" apart from "field never touched, still holding the 2.0 default". A user who explicitly sets auto_trigger_multiplier = 2.0 on a harness whose own default is NOT 2.0 (gemini's is 3.0) got their explicit value silently discarded in favor of the harness default -- backwards. This writes a real config.toml (via the mocked configPath()) with harness = 'gemini' and an explicit auto_trigger_multiplier = 2.0, then drives the real getContextPressure() path: it fails against a reader that still applies gemini's 3.0 harness default and passes once the real "was this explicitly set in the raw file" signal is threaded through.
    it('respects an explicit auto_trigger_multiplier that happens to equal the global default, even when the harness default differs', () => {
      fs.writeFileSync(
        _testConfigPath,
        `[compact_assist]
harness = "gemini"
auto_trigger_multiplier = 2.0
`,
        'utf8',
      )
      invalidateConfigCache()
      try {
        const cache = {
          loadedSkillTotalTokens: 100,
        }
        const pressure = getContextPressure(cache)
        // Explicit 2.0 must win over gemini's 3.0 harness default.
        const expected = (100 + CATALOG_TOKENS) / (CONTEXT_AUTOCOMPACT_TOKENS * 2.0)
        expect(pressure.fillFraction).toBeCloseTo(expected, 5)
      } finally {
        invalidateConfigCache()
        try {
          fs.unlinkSync(_testConfigPath)
        } catch {
          // best-effort cleanup
        }
      }
    })

    // Regression: isAutoTriggerMultiplierExplicit() only read the raw global config.toml, never the per-project .token-goat.toml override. A project that sets auto_trigger_multiplier solely via its .token-goat.toml (no global config.toml entry at all) had that explicit value misdetected as "still the default", so getEffectiveAutoTriggerWindow() discarded it in favor of the harness's own default multiplier -- the same "explicit vs default" bug the sibling test above covers, but for the per-project override file instead of the global one. This writes a real .token-goat.toml (via the mocked projectConfigPath()) with harness = 'gemini' and an explicit auto_trigger_multiplier = 2.0, and a global config.toml that sets neither, then drives the real getContextPressure() path: it fails against a reader that only checks the global file and passes once the per-project file is checked too.
    it('respects an explicit auto_trigger_multiplier set only via the per-project .token-goat.toml override', () => {
      fs.writeFileSync(_testConfigPath, '', 'utf8')
      fs.writeFileSync(
        _testProjectConfigPath,
        `[compact_assist]
harness = "gemini"
auto_trigger_multiplier = 2.0
`,
        'utf8',
      )
      invalidateConfigCache()
      try {
        const cache = {
          loadedSkillTotalTokens: 100,
        }
        const pressure = getContextPressure(cache)
        // Explicit 2.0 (from the project override) must win over gemini's 3.0 harness default.
        const expected = (100 + CATALOG_TOKENS) / (CONTEXT_AUTOCOMPACT_TOKENS * 2.0)
        expect(pressure.fillFraction).toBeCloseTo(expected, 5)
      } finally {
        invalidateConfigCache()
        for (const p of [_testConfigPath, _testProjectConfigPath]) {
          try {
            fs.unlinkSync(p)
          } catch {
            // best-effort cleanup
          }
        }
      }
    })
  })

  describe('getAutoTriggerMultiplier', () => {
    it('applies per-harness defaults when config is default', () => {
      const multiplier = getAutoTriggerMultiplier({
        configExplicitMultiplier: 2.0,
        harness: 'opencode',
        isConfigDefault: true,
      })
      expect(multiplier).toBe(2.5)
    })

    it('respects user-explicit values', () => {
      const multiplier = getAutoTriggerMultiplier({
        configExplicitMultiplier: 5.0,
        harness: 'claudecode',
        isConfigDefault: false,
      })
      expect(multiplier).toBe(5.0)
    })

    it('clamps to [1.0, 10.0]', () => {
      expect(
        getAutoTriggerMultiplier({
          configExplicitMultiplier: 0.5,
          isConfigDefault: false,
        })
      ).toBe(1.0)
      expect(
        getAutoTriggerMultiplier({
          configExplicitMultiplier: 15.0,
          isConfigDefault: false,
        })
      ).toBe(10.0)
    })

    it('auto-detects default when isConfigDefault is undefined', () => {
      const with20 = getAutoTriggerMultiplier({
        configExplicitMultiplier: 2.0,
        harness: 'codex',
      })
      expect(with20).toBe(1.5)

      const with30 = getAutoTriggerMultiplier({
        configExplicitMultiplier: 3.0,
        harness: 'codex',
      })
      expect(with30).toBe(3.0)
    })
  })

  describe('isNoisePath', () => {
    it('returns false for empty paths', () => {
      expect(isNoisePath('')).toBe(false)
    })

    it('filters by extension', () => {
      expect(isNoisePath('file.pyc')).toBe(true)
      expect(isNoisePath('file.log')).toBe(true)
      expect(isNoisePath('file.d.ts')).toBe(true)
      expect(isNoisePath('file.ts')).toBe(false)
    })

    it('filters by basename', () => {
      expect(isNoisePath('package-lock.json')).toBe(true)
      expect(isNoisePath('poetry.lock')).toBe(true)
      expect(isNoisePath('.DS_Store')).toBe(true)
      expect(isNoisePath('thumbs.db')).toBe(true)
      expect(isNoisePath('package.json')).toBe(false)
    })

    it('filters by path segment', () => {
      expect(isNoisePath('src/__pycache__/foo.pyc')).toBe(true)
      expect(isNoisePath('project/node_modules/lib.js')).toBe(true)
      expect(isNoisePath('repo/.git/config')).toBe(true)
      expect(isNoisePath('src/main.ts')).toBe(false)
    })

    it('filters automation tool files', () => {
      expect(isNoisePath('.improve-state-abc.json')).toBe(true)
      expect(isNoisePath('improve_commit_msg_1.txt')).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(isNoisePath('FILE.PYC')).toBe(true)
      expect(isNoisePath('PACKAGE-LOCK.JSON')).toBe(true)
    })

    it('handles backslashes on Windows', () => {
      expect(isNoisePath('src\\.git\\config')).toBe(true)
      expect(isNoisePath('dir\\node_modules\\lib.js')).toBe(true)
    })
  })

  describe('normalizeForCache', () => {
    it('strips trailing "# as-of:" line', () => {
      const input = 'Line 1\nLine 2\n# as-of: 2024-01-01T00:00:00Z'
      const result = normalizeForCache(input)
      expect(result).toBe('Line 1\nLine 2')
    })

    it('preserves text without "# as-of:" suffix', () => {
      const input = 'Line 1\nLine 2'
      const result = normalizeForCache(input)
      expect(result).toBe('Line 1\nLine 2')
    })

    it('handles empty input', () => {
      expect(normalizeForCache('')).toBe('')
    })

    it('trims whitespace and handles single line with as-of', () => {
      const input = '# as-of: 2024-01-01T00:00:00Z\n'
      const result = normalizeForCache(input)
      expect(result).toBe('')
    })
  })

  describe('computeAdaptiveBudget', () => {
    it('returns minimum budget for empty cache', () => {
      const cache = {}
      const budget = computeAdaptiveBudget(cache)
      expect(budget).toBeGreaterThanOrEqual(200)
      expect(budget).toBeLessThanOrEqual(800)
    })

    it('adds bonus for edited files', () => {
      const cache: SessionCacheObject = {
        files: [
          fileEntry('a.ts', { wasEdited: true }),
          fileEntry('b.ts', { wasEdited: true }),
          fileEntry('c.ts', { wasEdited: true }),
        ],
      }
      const budget = computeAdaptiveBudget(cache)
      expect(budget).toBeGreaterThan(200)
    })

    it('caps budget based on context pressure', () => {
      const cache: SessionCacheObject = {
        files: [
          fileEntry('a.ts', { wasEdited: true }),
          fileEntry('b.ts', { wasEdited: true }),
          fileEntry('c.ts', { wasEdited: true }),
        ],
      }
      const budgetCritical = computeAdaptiveBudget(cache, 0, {
        contextPressure: { fillFraction: 0.9, tier: 'critical' },
      })
      expect(budgetCritical).toBeLessThanOrEqual(300)

      const budgetHot = computeAdaptiveBudget(cache, 0, {
        contextPressure: { fillFraction: 0.75, tier: 'hot' },
      })
      expect(budgetHot).toBeLessThanOrEqual(500)
    })

    it('applies activity multiplier for mature sessions', () => {
      const cache: SessionCacheObject = {
        files: [fileEntry('a.ts', { wasEdited: true }), fileEntry('b.ts', { wasEdited: true })],
      }
      const budgetYoung = computeAdaptiveBudget(cache, 300)
      const budgetMature = computeAdaptiveBudget(cache, 4000)
      expect(budgetMature).toBeGreaterThan(budgetYoung)
    })
  })

  describe('eventCount', () => {
    it('includes webFetches in the total (fail-on-buggy: webFetches omitted from the sum, unlike the pre-fix sum)', () => {
      const cache: SessionCacheObject = {
        files: [fileEntry('a.ts'), fileEntry('b.ts', { wasEdited: true })],
        bashOutputs: [['cmd1', 'out1']],
        webFetches: [['https://example.com', 'w1'], ['https://example.org', 'w2']],
        skillHistory: { skillA: {} },
      }
      // files.length(2: a.ts + b.ts) + editedCount(1: b.ts) + bash(1) + web(2) + skill(1) = 7
      expect(eventCount(cache)).toBe(7)
    })

    it('returns 0 for an empty cache', () => {
      expect(eventCount({})).toBe(0)
    })

    // Regression: eventCount used to read cache.bashHistory/cache.webHistory, field names loadSessionCache never populated (it only ever set `files`), so real recorded bash/web activity was silently excluded from every event count.
    it('counts real recorded bash/web activity loaded via loadSessionCache', () => {
      const prevHome = process.env['TOKEN_GOAT_HOME']
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compact-eventcount-'))
      process.env['TOKEN_GOAT_HOME'] = tmpHome
      resetSessionState()
      try {
        recordFileRead('C:/proj/src/one.ts')
        recordBashOutput('hash1', 'out1', 10)
        recordWebFetch('https://example.com', 'prompt', 'wout1')
        recordWebFetch('https://example.org', 'prompt2', 'wout2')
        saveSessionState('eventcount-real-session')

        const cache = loadSessionCache('eventcount-real-session')
        expect(cache).not.toBeNull()
        // files.length(1) + editedCount(0) + bash(1) + web(2) + skill(0) = 4
        expect(eventCount(cache ?? {})).toBe(4)
      } finally {
        resetSessionState()
        if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
        else process.env['TOKEN_GOAT_HOME'] = prevHome
        try {
          fs.rmSync(tmpHome, { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
    })
  })

  describe('session directory resolution (regression)', () => {
    // findLatestSessionId / loadSessionCache must read from the same base directory the real session writer (session_store.ts) uses — tokenGoatHome() (honors TOKEN_GOAT_HOME) — not dataDir() (honors XDG_DATA_HOME), a different directory nothing ever writes session blobs under. storeBlob writes through the same tokenGoatHome()-based path as the production writer, so this exercises the real read/write pairing instead of an injected seam.
    let prevHome: string | undefined
    let tmpHome: string

    beforeEach(() => {
      prevHome = process.env['TOKEN_GOAT_HOME']
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compact-test-'))
      process.env['TOKEN_GOAT_HOME'] = tmpHome
      resetSessionState()
    })

    afterEach(() => {
      resetSessionState()
      if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
      else process.env['TOKEN_GOAT_HOME'] = prevHome
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    })

    it('findLatestSessionId finds a session blob written under TOKEN_GOAT_HOME', () => {
      storeBlob(SESSIONS_SUBDIR, 'real-session-id', { files: [] })
      expect(findLatestSessionId()).toBe('real-session-id')
    })

    // Regression for the array-vs-dict shape mismatch: SessionCacheObject.files used to be typed as a path-keyed dict (`Record<string, unknown>`), the OLD Python-era on-disk format. The real writer, session_store.ts's saveSessionState (driven here through its actual public API — recordFileRead / recordFileEdit / saveSessionState — not a hand-built blob), persists `files` as a `FileEntry[]` array. Object.keys() on that array yields numeric indices ("0", "1") instead of real paths, so a manifest built from a real on-disk session used to render garbage instead of the actual read/edited files. These tests drive the real save -> load -> manifest pipeline end to end so they fail on the buggy dict-shaped reader and pass once compact.ts reads the real FileEntry[] shape.
    it('loadSessionCache and the manifest builder both read real session data written under TOKEN_GOAT_HOME', () => {
      recordFileRead('C:/proj/src/gamma.ts')
      recordFileRead('C:/proj/src/gamma.ts')
      recordFileEdit('C:/proj/src/delta.ts')
      saveSessionState('real-session-id')

      // files.length(2: gamma.ts + delta.ts) + editedCount(1: delta.ts) = 3
      expect(eventCount(loadSessionCache('real-session-id') ?? {})).toBe(3)
      const manifest = buildManifest('real-session-id')
      expect(manifest).toContain('gamma.ts')
      expect(manifest).toContain('delta.ts')
    })

    it('carries the project notes behind the edits and ahead of the reads, so a long read list cannot cut them', () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-manifest-notes-'))
      try {
        fs.writeFileSync(path.join(projectDir, 'package.json'), '{}')
        setEntry(findProject(projectDir)!.hash, 'registry', '118615 and 118623 are the same brand under two ids')
        recordFileEdit('/proj/src/edited.ts')
        for (let i = 0; i < 45; i++) recordFileRead(`/proj/src/read-only-file-number-${i}.ts`)
        saveSessionState('notes-session')

        const manifest = buildManifest('notes-session', projectDir)
        const note = manifest.indexOf('- **registry**: 118615 and 118623 are the same brand under two ids')
        expect(note, 'the note must survive the character cap').toBeGreaterThan(-1)
        expect(manifest.indexOf('/proj/src/edited.ts')).toBeLessThan(note)
        expect(note).toBeLessThan(manifest.indexOf('### Read files'))
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    })

    // ---- manifest disclosure -------------------------------------------------------------
    //
    // Why nothing caught this: every manifest test above asserts the manifest CONTAINS an expected path. None asserted anything about what it left out, and the three sections ("Edited files", "Files read", "Web fetches") each dropped rows two ways -- a row cap and a mid-loop token-budget break -- while rendering the survivors as a plain bullet list. A short list was byte-identical to a complete one. The manifest is handed to the model immediately before compaction, so that list reads as the record of the session.

    it('discloses the files it left out of the read section rather than rendering a short list as a complete one', () => {
      // 45 short paths: past the 40-row section cap, and small enough in total that the max_manifest_chars cap does not also fire -- otherwise the outer truncation would eat the very disclosure line this asserts on, and the test would be measuring the wrong layer.
      const TOTAL = 45
      for (let i = 0; i < TOTAL; i++) recordFileRead(`/proj/src/f${String(i).padStart(2, '0')}.ts`)
      saveSessionState('read-cap-session')

      const manifest = buildManifest('read-cap-session')
      const shown = manifest.split('\n').filter((l: string) => /^- \/proj\/src\/f\d\d\.ts/i.test(l)).length

      // Calibration: the cap must actually engage, or the disclosure assertion below is asserting on an uncapped list and proves nothing.
      expect(shown, `${TOTAL} files were read but ${shown} rendered; the cap is not engaging`).toBeLessThan(TOTAL)
      expect(shown).toBeGreaterThan(0)
      expect(manifest, 'the read section dropped rows and said nothing').toContain(`- ...and ${TOTAL - shown} more`)
    })

    it('spends the read cap on files it will actually show, not on noise paths it then drops', () => {
      // The cap used to be applied BEFORE the noise filter, so a session whose most-read paths were all noise rendered "## Files read" as a heading with nothing under it -- a heading that asserts the list below is what was read.
      for (let i = 0; i < 18; i++) {
        recordFileRead(`C:/proj/node_modules/pkg${i}/index.js`)
        recordFileRead(`C:/proj/node_modules/pkg${i}/index.js`)
      }
      recordFileRead('C:/proj/src/real.ts')
      saveSessionState('noise-first-session')

      const manifest = buildManifest('noise-first-session')
      // Must-not-drop anchor: the one real file has to survive. A collapse that hid everything would satisfy any "no noise in the output" assertion on its own.
      const readSection = manifest.split('### Read files')[1]?.split('###')[0] ?? ''
      expect(readSection, 'the only non-noise file read was dropped in favour of noise paths').toContain('real.ts')
      expect(readSection, 'noise paths must not reach the read section').not.toContain('node_modules')
    })

    it('says nothing about omissions when every file fits', () => {
      // The negative half. A disclosure line emitted unconditionally would pass the case above on its own while lying on every ordinary session.
      recordFileRead('C:/proj/src/only.ts')
      recordFileEdit('C:/proj/src/edited.ts')
      saveSessionState('fits-session')

      const manifest = buildManifest('fits-session')
      expect(manifest).toContain('only.ts')
      expect(manifest).toContain('edited.ts')
      expect(manifest, 'a complete manifest must not claim rows were omitted').not.toMatch(/and \d+ more/)
    })

    it('buildManifest renders real file paths, not numeric array indices, from a session written by the real saveSessionState writer', () => {
      recordFileRead('C:/proj/src/alpha.ts')
      recordFileEdit('C:/proj/src/beta.ts')
      saveSessionState('real-shape-session')

      const manifest = buildManifest('real-shape-session')
      expect(manifest).toContain('alpha.ts')
      expect(manifest).toContain('beta.ts')
      // Against the dict-shaped reader, Object.keys() on the real FileEntry[] array would render "- 0" / "- 1" instead of the actual paths.
      expect(manifest).not.toMatch(/^- 0(\s|$)/m)
      expect(manifest).not.toMatch(/^- 1(\s|$)/m)
    })

    it('buildManifest classifies edited vs read files correctly from a real session', () => {
      recordFileRead('C:/proj/src/readonly.ts')
      recordFileEdit('C:/proj/src/edited.ts')
      saveSessionState('real-classification-session')

      const manifest = buildManifest('real-classification-session')
      const editedSection = manifest.split('### Edited files')[1]?.split('###')[0] ?? ''
      const readSection = manifest.split('### Read files')[1]?.split('###')[0] ?? ''
      expect(editedSection).toContain('edited.ts')
      expect(editedSection).not.toContain('readonly.ts')
      expect(readSection).toContain('readonly.ts')
      expect(readSection).not.toContain('edited.ts')
    })

    // Regression: the web ledger used to be dropped on the way from disk into the manifest, so a session's fetched URLs never rendered no matter how many it recorded. Bash output is not asserted here -- it reaches the manifest through SAFE_TO_DISCARD, which is covered against real stored output in hooks_compact.test.ts.
    it('renders fetched URLs from real recorded activity', () => {
      recordWebFetch('https://example.com/page', 'prompt', 'wout1')
      saveSessionState('real-web-session')

      const manifest = buildManifest('real-web-session')
      expect(manifest).toContain('### Web URLs fetched')
      expect(manifest).toContain('https://example.com/page')
    })
  })

  // End-to-end coverage for two fields that compact.ts reads but that nothing used to write, so their contributions were permanently dead: - symbols_read -> symbolsBonus (was always 0) - created_ts   -> session-age budget multiplier (was always the young/0.6 tier) These drive the REAL production path (postBashHandler hook / saveSessionState writer -> loadSessionCache reader -> compact consumer), not a hand-built cache, so they fail against the pre-fix dead-code behavior and pass once wired.
  describe('dead-field wiring (symbolsBonus + created_ts)', () => {
    let prevHome: string | undefined
    let tmpHome: string

    beforeEach(() => {
      prevHome = process.env['TOKEN_GOAT_HOME']
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compact-deadfield-'))
      process.env['TOKEN_GOAT_HOME'] = tmpHome
      resetSessionState()
    })

    afterEach(() => {
      resetSessionState()
      if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
      else process.env['TOKEN_GOAT_HOME'] = prevHome
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    })

    function postBash(command: string): Promise<unknown> {
      return postBashHandler(
        makeHookEvent({
          eventName: 'post_tool_use',
          toolName: 'Bash',
          toolInput: { command },
          sessionId: 'deadfield-session',
          raw: { tool_name: 'Bash', tool_input: { command }, tool_response: 'ok', cwd: tmpHome },
        }),
      )
    }

    // Bug 1: a surgical `token-goat read file::symbol` must, via the real hook, mark the file's session entry with symbols_read so computeAdaptiveBudget's symbolsBonus fires. Pre-fix nothing wrote the field, so symbolFiles was always 0 and the bonus 0 (budget would be 200 here, not 350).
    it('rewards surgical reads recorded through the real postBashHandler hook path', async () => {
      const files = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
      for (const name of files) {
        const abs = path.join(tmpHome, `${name}.ts`).replace(/\\/g, '/')
        await postBash(`token-goat read ${abs}::sym_${name}`)
      }
      saveSessionState('symbols-e2e')

      const cache = loadSessionCache('symbols-e2e')
      expect(cache).not.toBeNull()
      const symbolFiles = (cache!.files ?? []).filter(
        (f) => ((f as unknown as Record<string, unknown>)['symbols_read'] as unknown[] | undefined)?.length,
      )
      // All five surgical reads must have persisted their symbols_read token.
      expect(symbolFiles).toHaveLength(5)

      // age 4000s + zero edits -> activity factor 1.0, so no minTotal floor masks the bonus: rawTotal = base(200) + symbolsBonus(min(150, 5*30)=150) = 350.
      const budget = computeAdaptiveBudget(cache ?? {}, 4000)
      expect(budget).toBe(350)
      // Sanity: with no symbol reads the same age yields only the base 200.
      expect(computeAdaptiveBudget({}, 4000)).toBe(200)
    })

    // Bug 2: the manifest budget scales by the session cache's real age, derived from the persisted created_ts. Pre-fix created_ts was never written and loadSessionCache dropped it, so age was always 0 (young tier) and an old cache produced the same budget as a fresh one. Asserted on the round trip itself rather than through a rendered manifest: the two things that broke are the writer stamping the field and the reader returning it, and a row count downstream of a character cap only observes them through two more layers of budgeting.
    it('persists created_ts and lets it drive the session-age budget tier', () => {
      for (let i = 0; i < 40; i++) recordFileEdit(`/proj/src/edited${i}.ts`)
      saveSessionState('age-e2e')

      const p = path.join(tmpHome, SESSIONS_SUBDIR, 'age-e2e.json')
      const nowSecs = Math.floor(Date.now() / 1000)
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
      expect(typeof raw['created_ts'], 'saveSessionState must stamp created_ts').toBe('number')

      // Mature cache: created ~4000s ago (>3600s tier). 40 edits over ~66min keeps edit density above the 0.3/min floor, so the multiplier stays at 1.4.
      raw['created_ts'] = nowSecs - 4000
      fs.writeFileSync(p, JSON.stringify(raw), 'utf8')
      const mature = loadSessionCache('age-e2e')
      expect(mature?.created_ts).toBe(nowSecs - 4000)
      const matureBudget = computeAdaptiveBudget(mature ?? {}, nowSecs - (mature?.created_ts ?? nowSecs))

      // Young cache: created just now -> 0.6 tier.
      raw['created_ts'] = nowSecs
      fs.writeFileSync(p, JSON.stringify(raw), 'utf8')
      const young = loadSessionCache('age-e2e')
      const youngBudget = computeAdaptiveBudget(young ?? {}, nowSecs - (young?.created_ts ?? nowSecs))

      expect(matureBudget).toBeGreaterThan(youngBudget)
    })
  })

  describe('measurePromptTokens', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'transcript_usage_capture.jsonl')

    // tests/fixtures/transcript_usage_capture.jsonl: 3 real transcript lines captured from Claude Code 2.1.270 (PROVENANCE: CAPTURE). Session, request and message identifiers were replaced with placeholders and the message content blocks with one text block, since neither is what this measures; every field name, nesting depth and usage number is as the harness wrote it, which is the part the reader depends on. Their usage totals, in file order, are 110979, 111210, 120719 -- distinct and non-monotonic-by-position-coincidence, so a reader that returned the *first* parseable record instead of the *last* would report 110979, not 120719, and this assertion would catch it.
    it('returns the sum from the last usage record in the file, not the first', () => {
      expect(measurePromptTokens(fixturePath)).toBe(120719)
    })

    it('returns null for a missing file', () => {
      expect(measurePromptTokens(path.join(__dirname, 'fixtures', 'does-not-exist.jsonl'))).toBeNull()
    })

    it('returns null for an empty file', () => {
      const tmp = path.join(os.tmpdir(), `tg-transcript-empty-${Date.now()}.jsonl`)
      fs.writeFileSync(tmp, '', 'utf8')
      try {
        expect(measurePromptTokens(tmp)).toBeNull()
      } finally {
        fs.unlinkSync(tmp)
      }
    })

    // The lines below are HAND-DERIVED (a plain user-turn line and a malformed line), not captured wire output: they exist only to prove the parser skips a record with no `usage` and a line that fails JSON.parse, not to assert anything about a real transcript's shape.
    it('returns null for a file with no usage record', () => {
      const tmp = path.join(os.tmpdir(), `tg-transcript-no-usage-${Date.now()}.jsonl`)
      fs.writeFileSync(tmp, '{"type":"user","message":{"role":"user","content":"hi"}}\nnot json at all\n', 'utf8')
      try {
        expect(measurePromptTokens(tmp)).toBeNull()
      } finally {
        fs.unlinkSync(tmp)
      }
    })
  })
})
