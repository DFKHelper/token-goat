/**
 * Tests for compact.ts functions.
 */

import { describe, expect, it } from 'vitest'
import {
  CATALOG_TOKENS,
  CONTEXT_AUTOCOMPACT_TOKENS,
  CONTEXT_TIER_CRITICAL,
  CONTEXT_TIER_HOT,
  CONTEXT_TIER_WARM,
  buildManifest,
  buildManifestAdaptive,
  buildManifestWithCount,
  computeAdaptiveBudget,
  estimateTokens,
  getAutoTriggerMultiplier,
  getContextPressure,
  isNoisePath,
  mergeSessionManifests,
  normalizeForCache,
  tierForFraction,
} from '../src/compact.js'

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
    it('returns cool pressure with no cache', () => {
      const pressure = getContextPressure()
      expect(pressure.fillFraction).toBe(0.0)
      expect(pressure.tier).toBe('cool')
    })

    it('computes pressure from measured tokens', () => {
      const cache = {
        loadedSkillTotalTokens: 100,
        observedToolTokens: 500_000,
        pressureBaselineTokens: 0,
      }
      const pressure = getContextPressure(cache)
      const expected = (100 + CATALOG_TOKENS + 500_000) / CONTEXT_AUTOCOMPACT_TOKENS
      expect(pressure.fillFraction).toBeCloseTo(expected, 5)
      expect(pressure.tier).toBe('hot')
    })

    it('subtracts baseline from raw total', () => {
      const cache = {
        loadedSkillTotalTokens: 100,
        observedToolTokens: 100_000,
        pressureBaselineTokens: 50_000,
      }
      const pressure = getContextPressure(cache)
      const expected = (100 + CATALOG_TOKENS + 100_000 - 50_000) / CONTEXT_AUTOCOMPACT_TOKENS
      expect(pressure.fillFraction).toBeCloseTo(expected, 5)
    })

    it('falls back to legacy proxies when observed tokens is 0', () => {
      const cache = {
        loadedSkillTotalTokens: 0,
        observedToolTokens: 0,
        pressureBaselineTokens: 0,
        bashHistory: { cmd1: {}, cmd2: {} },
        webHistory: { url1: {} },
        files: { 'a.ts': {}, 'b.ts': {}, 'c.ts': {} },
      }
      const pressure = getContextPressure(cache)
      const expected =
        (CATALOG_TOKENS + 2 * 500 + 1 * 1_000 + 3 * 200) / CONTEXT_AUTOCOMPACT_TOKENS
      expect(pressure.fillFraction).toBeCloseTo(expected, 5)
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

  describe('mergeSessionManifests', () => {
    it('deduplicates by rel_path keeping highest hit_count', () => {
      const manifests = [
        {
          files: [
            { rel_path: 'a.ts', hit_count: 3 },
            { rel_path: 'b.ts', hit_count: 1 },
          ],
        },
        {
          files: [
            { rel_path: 'a.ts', hit_count: 5 },
            { rel_path: 'c.ts', hit_count: 2 },
          ],
        },
      ]
      const result = mergeSessionManifests(manifests as Record<string, unknown>[], 1000)
      expect(result).toHaveLength(3)
      const aTs = result.find((e: Record<string, unknown>) => e.rel_path === 'a.ts')
      expect(aTs?.hit_count).toBe(5)
    })

    it('sorts by hit_count descending', () => {
      const manifests = [
        {
          files: [
            { rel_path: 'c.ts', hit_count: 1 },
            { rel_path: 'a.ts', hit_count: 10 },
            { rel_path: 'b.ts', hit_count: 5 },
          ],
        },
      ]
      const result = mergeSessionManifests(manifests as Record<string, unknown>[], 1000)
      expect((result[0] as Record<string, unknown>).rel_path).toBe('a.ts')
      expect((result[1] as Record<string, unknown>).rel_path).toBe('b.ts')
      expect((result[2] as Record<string, unknown>).rel_path).toBe('c.ts')
    })

    it('respects budget constraint', () => {
      const manifests = [
        {
          files: [
            { rel_path: 'very/long/path/to/a.ts', hit_count: 10 },
            { rel_path: 'b.ts', hit_count: 5 },
            { rel_path: 'c.ts', hit_count: 1 },
          ],
        },
      ]
      const result = mergeSessionManifests(manifests as Record<string, unknown>[], 2)
      expect(result.length).toBeLessThanOrEqual(2)
    })

    it('uses ~3 chars/token ratio so a long path exhausts budget quickly', () => {
      // "src/foo/bar/baz.ts" = 18 chars → floor(18/3)+1=7 tokens. With a budget
      // of 10 it fits; with a budget of 5 the loop breaks before adding it.
      // With the old /10 divisor (floor(18/10)+1=2 tokens) both budgets would
      // have included the entry, silently exceeding the true token cost.
      const manifests = [
        {
          files: [
            { rel_path: 'src/foo/bar/baz.ts', hit_count: 10 },
            { rel_path: 'a.ts', hit_count: 5 },
          ],
        },
      ]
      // Budget 10: "src/foo/bar/baz.ts" (18 chars) costs floor(18/3)+1=7 tokens → fits;
      // "a.ts" (4 chars) costs floor(4/3)+1=2 tokens → running total 9 which fits in 10.
      const resultFits = mergeSessionManifests(manifests as Record<string, unknown>[], 10)
      expect(resultFits).toHaveLength(2)

      // Budget 5: first entry costs 7 tokens > 5 → loop breaks immediately.
      // With the old /10 divisor it would cost only 1 token and both entries would fit.
      const resultExceeds = mergeSessionManifests(manifests as Record<string, unknown>[], 5)
      expect(resultExceeds).toHaveLength(0)
    })

    it('handles missing files field gracefully', () => {
      const manifests = [{ other_field: 'value' }]
      const result = mergeSessionManifests(manifests as Record<string, unknown>[], 1000)
      expect(result).toEqual([])
    })

    it('skips entries without rel_path', () => {
      const manifests = [
        {
          files: [{ hit_count: 5 }, { rel_path: 'a.ts', hit_count: 10 }],
        },
      ]
      const result = mergeSessionManifests(manifests as Record<string, unknown>[], 1000)
      expect(result).toHaveLength(1)
      expect((result[0] as Record<string, unknown>).rel_path).toBe('a.ts')
    })

    it('token calculation in mergeSessionManifests must match estimateTokens +1 formula', () => {
      const manifestPath = 'x'.repeat(300)
      const manifests = [
        {
          files: [
            { rel_path: manifestPath, hit_count: 100 },
            { rel_path: 'a.ts', hit_count: 50 },
          ],
        },
      ]
      const estimatedViaFunc = estimateTokens(manifestPath)
      const budget = estimatedViaFunc + 10
      const result = mergeSessionManifests(manifests as Record<string, unknown>[], budget)
      expect(result).toHaveLength(2)
      expect((result[0] as Record<string, unknown>).rel_path).toBe(manifestPath)
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
      const cache = {
        editedFiles: {
          'a.ts': {},
          'b.ts': {},
          'c.ts': {},
        },
      }
      const budget = computeAdaptiveBudget(cache)
      expect(budget).toBeGreaterThan(200)
    })

    it('caps budget based on context pressure', () => {
      const cache = {
        editedFiles: {
          'a.ts': {},
          'b.ts': {},
          'c.ts': {},
        },
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
      const cache = {
        editedFiles: { 'a.ts': {}, 'b.ts': {} },
      }
      const budgetYoung = computeAdaptiveBudget(cache, 300)
      const budgetMature = computeAdaptiveBudget(cache, 4000)
      expect(budgetMature).toBeGreaterThan(budgetYoung)
    })
  })

  describe('buildManifest', () => {
    it('returns empty string for missing session', () => {
      const manifest = buildManifest('nonexistent-session-id')
      expect(manifest).toBe('')
    })

    it('returns empty string when session cache not on disk', () => {
      const manifest = buildManifest('test-session')
      expect(typeof manifest).toBe('string')
    })
  })

  describe('buildManifestWithCount', () => {
    it('returns empty manifest and zero count for missing session', () => {
      const [manifest, count] = buildManifestWithCount('nonexistent-session-id')
      expect(manifest).toBe('')
      expect(count).toBe(0)
    })

    it('returns tuple with text and number', () => {
      const result = buildManifestWithCount('nonexistent-session-id')
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(2)
      expect(typeof result[0]).toBe('string')
      expect(typeof result[1]).toBe('number')
    })
  })

  describe('buildManifestAdaptive', () => {
    it('returns empty string for missing session', () => {
      const manifest = buildManifestAdaptive('nonexistent-session-id')
      expect(manifest).toBe('')
    })
  })
})
