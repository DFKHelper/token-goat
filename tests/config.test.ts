import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — this redirects configPath() to a per-test temp file.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = path.join(os.tmpdir(), `tg-config-test-${process.pid}.toml`)

import {
  defaultConfig,
  invalidateConfigCache,
  loadConfig,
  saveConfig,
} from '../src/config.js'

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ignore
  }
})

// ---------------------------------------------------------------------------
// loadConfig suite
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  beforeEach(() => {
    invalidateConfigCache()
    // Remove any leftover config file from previous test
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
  })

  afterEach(() => {
    invalidateConfigCache()
    vi.restoreAllMocks()
  })

  it('returns all defaults when config file is absent', () => {
    const cfg = loadConfig()
    const def = defaultConfig()

    expect(cfg.compact_assist.enabled).toBe(def.compact_assist.enabled)
    expect(cfg.compact_assist.min_events).toBe(def.compact_assist.min_events)
    expect(cfg.bash_compress.max_lines).toBe(def.bash_compress.max_lines)
    expect(cfg.hints.backoff_thresholds).toEqual(def.hints.backoff_thresholds)
    expect(cfg.skill_preservation.orphan_age_secs).toBe(def.skill_preservation.orphan_age_secs)
  })

  it('applies env var override for TOKEN_GOAT_COMPACT_ASSIST', () => {
    const orig = process.env['TOKEN_GOAT_COMPACT_ASSIST']
    try {
      process.env['TOKEN_GOAT_COMPACT_ASSIST'] = '0'
      const cfg = loadConfig()
      expect(cfg.compact_assist.enabled).toBe(false)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_COMPACT_ASSIST']
      } else {
        process.env['TOKEN_GOAT_COMPACT_ASSIST'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_BASH_COMPRESS', () => {
    const orig = process.env['TOKEN_GOAT_BASH_COMPRESS']
    try {
      process.env['TOKEN_GOAT_BASH_COMPRESS'] = 'false'
      const cfg = loadConfig()
      expect(cfg.bash_compress.enabled).toBe(false)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_BASH_COMPRESS']
      } else {
        process.env['TOKEN_GOAT_BASH_COMPRESS'] = orig
      }
    }
  })

  it('mtime cache: second call with unchanged file returns same object reference', () => {
    // Write a minimal TOML so the file exists
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')

    const first = loadConfig()
    const second = loadConfig()
    expect(second).toBe(first)
  })

  it('mtime cache: invalidated by invalidateConfigCache()', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')

    const first = loadConfig()
    invalidateConfigCache()
    const second = loadConfig()
    // Same values but different object (re-parsed)
    expect(second).not.toBe(first)
    expect(second.compact_assist.min_events).toBe(4)
  })

  it('round-trips saveConfig → loadConfig with modified values', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.min_events = 7
    cfg.bash_compress.max_lines = 500
    cfg.hints.git_hint_max_ms = 99
    cfg.worker.max_pool_workers = 2
    cfg.image_shrink.jpeg_quality = 85

    saveConfig(cfg)
    // saveConfig calls invalidateConfigCache internally
    const loaded = loadConfig()

    expect(loaded.compact_assist.min_events).toBe(7)
    expect(loaded.bash_compress.max_lines).toBe(500)
    expect(loaded.hints.git_hint_max_ms).toBe(99)
    expect(loaded.worker.max_pool_workers).toBe(2)
    expect(loaded.image_shrink.jpeg_quality).toBe(85)
  })

  it('round-trips warn_unbalanced_shell_quoting, cross_session_read_dedup, and cross_session_read_dedup_ttl_secs (fail-on-buggy: saveConfig previously omitted these three hints fields, silently resetting them to defaults on every save)', () => {
    const cfg = defaultConfig()
    cfg.hints.warn_unbalanced_shell_quoting = !cfg.hints.warn_unbalanced_shell_quoting
    cfg.hints.cross_session_read_dedup = !cfg.hints.cross_session_read_dedup
    cfg.hints.cross_session_read_dedup_ttl_secs = cfg.hints.cross_session_read_dedup_ttl_secs + 123

    saveConfig(cfg)
    const loaded = loadConfig()

    expect(loaded.hints.warn_unbalanced_shell_quoting).toBe(cfg.hints.warn_unbalanced_shell_quoting)
    expect(loaded.hints.cross_session_read_dedup).toBe(cfg.hints.cross_session_read_dedup)
    expect(loaded.hints.cross_session_read_dedup_ttl_secs).toBe(cfg.hints.cross_session_read_dedup_ttl_secs)
  })
})

// ---------------------------------------------------------------------------
// Default field spot-checks
// ---------------------------------------------------------------------------

describe('defaultConfig field spot-checks', () => {
  it('CompactAssistConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.compact_assist.enabled).toBe(true)
    expect(cfg.compact_assist.triggers).toEqual(['manual', 'auto'])
    expect(cfg.compact_assist.auto_trigger_multiplier).toBe(2.0)
    expect(cfg.compact_assist.harness).toBe('auto')
  })

  // Regression: lazy_skill_injection was removed as dead config -- it was never read by any registered pre_compact hook. Guards against it silently reappearing on the config object.
  it('CompactAssistConfig no longer carries lazy_skill_injection', () => {
    const cfg = defaultConfig()
    expect(Object.hasOwn(cfg.compact_assist, 'lazy_skill_injection')).toBe(false)
  })

  it('BashCompressConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.bash_compress.enabled).toBe(true)
    expect(cfg.bash_compress.max_lines).toBe(1000)
    expect(cfg.bash_compress.cache_max_bytes).toBe(16 * 1024 * 1024)
    expect(cfg.bash_compress.cache_max_bytes_per_output).toBe(50 * 1024 * 1024)
  })

  it('SkillPreservationConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.skill_preservation.orphan_age_secs).toBe(604800)
    expect(cfg.skill_preservation.compress_bodies).toBe(true)
    expect(cfg.skill_preservation.first_load_compact).toBe(false)
    expect(cfg.skill_preservation.post_compact_full_loads).toBe(false)
  })

  it('HintsConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.hints.backoff_thresholds).toEqual([1, 3, 10, 30])
    expect(cfg.hints.reread_deny).toBe(true)
    expect(cfg.hints.reread_deny_min_bytes).toBe(2048)
    expect(cfg.hints.large_read_redirect_bytes).toBe(45_000)
  })

  it('ImageShrinkConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.image_shrink.prefer_avif).toBe(true)
    expect(cfg.image_shrink.avif_quality).toBe(60)
    expect(cfg.image_shrink.max_image_pixels).toBe(16_000_000)
  })
})
