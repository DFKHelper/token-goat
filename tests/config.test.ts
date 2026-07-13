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
  getLastConfigParseError,
  invalidateConfigCache,
  loadConfig,
  loadPersistedConfig,
  saveConfig,
} from '../src/config.js'
import { ENV_KEYS } from '../src/constants.js'

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

  // Regression: overflow_guard.enabled/max_tokens and hints.json_sidecar/large_read_redirect_bytes
  // were validated from TOML in _buildConfig but never given an envBool/envInt call afterward,
  // unlike every sibling field -- so their documented env vars (present in CHANGELOG.md since
  // v1.0.0-v1.6.0) silently had zero effect on the loaded config.
  it('applies env var override for TOKEN_GOAT_OVERFLOW_GUARD', () => {
    const orig = process.env['TOKEN_GOAT_OVERFLOW_GUARD']
    try {
      process.env['TOKEN_GOAT_OVERFLOW_GUARD'] = '0'
      const cfg = loadConfig()
      expect(cfg.overflow_guard.enabled).toBe(false)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_OVERFLOW_GUARD']
      } else {
        process.env['TOKEN_GOAT_OVERFLOW_GUARD'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_OVERFLOW_MAX_TOKENS', () => {
    const orig = process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
    try {
      process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '5000'
      const cfg = loadConfig()
      expect(cfg.overflow_guard.max_tokens).toBe(5000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
      } else {
        process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_HINT_JSON_SIDECAR', () => {
    const orig = process.env['TOKEN_GOAT_HINT_JSON_SIDECAR']
    try {
      process.env['TOKEN_GOAT_HINT_JSON_SIDECAR'] = '1'
      const cfg = loadConfig()
      expect(cfg.hints.json_sidecar).toBe(true)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_HINT_JSON_SIDECAR']
      } else {
        process.env['TOKEN_GOAT_HINT_JSON_SIDECAR'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_LARGE_READ_BYTES', () => {
    const orig = process.env['TOKEN_GOAT_LARGE_READ_BYTES']
    try {
      process.env['TOKEN_GOAT_LARGE_READ_BYTES'] = '1000'
      const cfg = loadConfig()
      expect(cfg.hints.large_read_redirect_bytes).toBe(1000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_LARGE_READ_BYTES']
      } else {
        process.env['TOKEN_GOAT_LARGE_READ_BYTES'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_OVERFLOW_MAX_TOKENS to the documented max (1000-1_000_000)', () => {
    const orig = process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
    try {
      process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '99999999'
      const cfg = loadConfig()
      expect(cfg.overflow_guard.max_tokens).toBe(1_000_000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
      } else {
        process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_LARGE_READ_BYTES to the documented max (0-100_000_000)', () => {
    const orig = process.env['TOKEN_GOAT_LARGE_READ_BYTES']
    try {
      process.env['TOKEN_GOAT_LARGE_READ_BYTES'] = '999999999'
      const cfg = loadConfig()
      expect(cfg.hints.large_read_redirect_bytes).toBe(100_000_000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_LARGE_READ_BYTES']
      } else {
        process.env['TOKEN_GOAT_LARGE_READ_BYTES'] = orig
      }
    }
  })

  // Regression: envInt() applied an env-var override AFTER the file-value min/max clamp with
  // no reclamp, so an out-of-range env var silently overwrote an already-validated value with
  // anything outside its documented range. Each case below sets the env var to a value clearly
  // outside the field's documented range and asserts loadConfig() clamps it back in, instead of
  // passing the raw out-of-range value through.
  it('clamps an out-of-range env var override for TOKEN_GOAT_MCP_DEDUP_TTL_SECS to the documented max (1-3600s)', () => {
    const orig = process.env['TOKEN_GOAT_MCP_DEDUP_TTL_SECS']
    try {
      process.env['TOKEN_GOAT_MCP_DEDUP_TTL_SECS'] = '99999999'
      const cfg = loadConfig()
      expect(cfg.hints.mcp_dedup_ttl_secs).toBe(3600)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_MCP_DEDUP_TTL_SECS']
      } else {
        process.env['TOKEN_GOAT_MCP_DEDUP_TTL_SECS'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS to the documented max (1-86400s)', () => {
    const orig = process.env['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS']
    try {
      process.env['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS'] = '999999999'
      const cfg = loadConfig()
      expect(cfg.hints.cross_session_read_dedup_ttl_secs).toBe(86400)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS']
      } else {
        process.env['TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS'] = orig
      }
    }
  })

  it('clamps a below-range env var override for TOKEN_GOAT_HOOK_WATCHDOG_MS to the documented min (100ms)', () => {
    const orig = process.env['TOKEN_GOAT_HOOK_WATCHDOG_MS']
    try {
      process.env['TOKEN_GOAT_HOOK_WATCHDOG_MS'] = '1'
      const cfg = loadConfig()
      expect(cfg.hooks.watchdog_ms).toBe(100)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_HOOK_WATCHDOG_MS']
      } else {
        process.env['TOKEN_GOAT_HOOK_WATCHDOG_MS'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_WORKER_MAX_POOL to the documented max (1-8)', () => {
    const orig = process.env['TOKEN_GOAT_WORKER_MAX_POOL']
    try {
      process.env['TOKEN_GOAT_WORKER_MAX_POOL'] = '999'
      const cfg = loadConfig()
      expect(cfg.worker.max_pool_workers).toBe(8)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WORKER_MAX_POOL']
      } else {
        process.env['TOKEN_GOAT_WORKER_MAX_POOL'] = orig
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

  it('the cached object is frozen (regression: a caller mutating a sub-field of the shared cached config, e.g. loadConfig().hints.foo = x, used to silently corrupt every other caller sharing that same reference until the next cache invalidation)', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')

    const cfg = loadConfig()

    expect(Object.isFrozen(cfg)).toBe(true)
    expect(Object.isFrozen(cfg.hints)).toBe(true)
    expect(Object.isFrozen(cfg.worker.blocked_roots)).toBe(true)
    expect(() => {
      ;(cfg as { compact_assist: { min_events: number } }).compact_assist.min_events = 999
    }).toThrow(TypeError)
    // The failed mutation attempt above must not have partially applied.
    expect(loadConfig().compact_assist.min_events).toBe(4)
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
    cfg.worker.blocked_roots = ['/tmp/blocked']
    cfg.image_shrink.jpeg_quality = 85

    saveConfig(cfg)
    // saveConfig calls invalidateConfigCache internally
    const loaded = loadConfig()

    expect(loaded.compact_assist.min_events).toBe(7)
    expect(loaded.bash_compress.max_lines).toBe(500)
    expect(loaded.hints.git_hint_max_ms).toBe(99)
    expect(loaded.worker.blocked_roots).toEqual(['/tmp/blocked'])
    expect(loaded.image_shrink.jpeg_quality).toBe(85)
  })

  it('treats a persisted reread_deny_min_bytes of exactly 2048 as the stale pre-a1fad4c6 default and falls through to the current default (51_200), instead of trusting it (regression: saveConfig always resaves every field, so a config set on any unrelated key before a1fad4c6 permanently persisted the then-in-memory-only 2048 default, which a1fad4c6 later wired up as the real re-read-deny gate)', () => {
    fs.writeFileSync(_testConfigPath, '[hints]\nreread_deny_min_bytes = 2048\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.hints.reread_deny_min_bytes).toBe(51_200)
  })

  it('respects a persisted reread_deny_min_bytes that is not the legacy 2048 sentinel (proving the fix only clobbers the exact stale default, not real user values)', () => {
    fs.writeFileSync(_testConfigPath, '[hints]\nreread_deny_min_bytes = 4096\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.hints.reread_deny_min_bytes).toBe(4096)
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
// Corrupt config.toml handling (#249 regression)
// ---------------------------------------------------------------------------

describe('loadConfig / loadPersistedConfig distinguish a parse failure from a missing file (#249 regression)', () => {
  beforeEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
  })

  afterEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
  })

  it('getLastConfigParseError() is null when config.toml is simply absent', () => {
    const cfg = loadConfig()
    expect(cfg.compact_assist.enabled).toBe(defaultConfig().compact_assist.enabled)
    expect(getLastConfigParseError()).toBeNull()
  })

  it('getLastConfigParseError() reports the parse failure when config.toml exists but is invalid TOML, while loadConfig still falls back to defaults', () => {
    fs.writeFileSync(_testConfigPath, 'this is not [ valid toml ===\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.enabled).toBe(defaultConfig().compact_assist.enabled)
    expect(getLastConfigParseError()).not.toBeNull()
  })

  it('getLastConfigParseError() clears back to null on the next load once the file is fixed', () => {
    fs.writeFileSync(_testConfigPath, 'this is not [ valid toml ===\n', 'utf8')
    invalidateConfigCache()
    loadConfig()
    expect(getLastConfigParseError()).not.toBeNull()

    fs.writeFileSync(_testConfigPath, '[compact_assist]\nenabled = false\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.enabled).toBe(false)
    expect(getLastConfigParseError()).toBeNull()
  })

  it('loadPersistedConfig() also reports the parse failure, distinct from an absent file', () => {
    const cfg1 = loadPersistedConfig()
    expect(cfg1.compact_assist.enabled).toBe(defaultConfig().compact_assist.enabled)
    expect(getLastConfigParseError()).toBeNull()

    fs.writeFileSync(_testConfigPath, '[[[not toml\n', 'utf8')
    const cfg2 = loadPersistedConfig()
    expect(cfg2.compact_assist.enabled).toBe(defaultConfig().compact_assist.enabled)
    expect(getLastConfigParseError()).not.toBeNull()
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
    expect(cfg.hints.reread_deny_min_bytes).toBe(51_200)
    expect(cfg.hints.large_read_redirect_bytes).toBe(512_000)
  })

  it('ImageShrinkConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.image_shrink.jpeg_quality).toBe(75)
    expect(cfg.image_shrink.max_image_pixels).toBe(16_000_000)
    expect(cfg.image_shrink.screenshot_redirect).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-field config invariants
// ---------------------------------------------------------------------------

describe('cross-field config clamping', () => {
  beforeEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
  })

  afterEach(() => {
    invalidateConfigCache()
  })

  it('clamps large_file_symbol_only_kb to not exceed large_file_skip_kb when symbol_only_kb is configured larger', () => {
    fs.writeFileSync(
      _testConfigPath,
      '[indexing]\nlarge_file_symbol_only_kb = 1000\nlarge_file_skip_kb = 500\n'
    )
    const cfg = loadConfig()
    expect(cfg.indexing.large_file_symbol_only_kb).toBe(500)
    expect(cfg.indexing.large_file_skip_kb).toBe(500)
  })

  it('applies env var override for TOKEN_GOAT_BASH_DEDUP_MIN_BYTES', () => {
    const orig = process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES']
    try {
      process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'] = '1234'
      const cfg = loadConfig()
      expect(cfg.hints.bash_dedup_min_bytes).toBe(1234)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES']
      } else {
        process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_BASH_DEDUP_MIN_BYTES to the documented max (0-100_000)', () => {
    const orig = process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES']
    try {
      process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'] = '999999999'
      const cfg = loadConfig()
      expect(cfg.hints.bash_dedup_min_bytes).toBe(100_000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES']
      } else {
        process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_WEB_DEDUP_MIN_BYTES', () => {
    const orig = process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES']
    try {
      process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES'] = '1234'
      const cfg = loadConfig()
      expect(cfg.hints.web_dedup_min_bytes).toBe(1234)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES']
      } else {
        process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_WEB_DEDUP_MIN_BYTES to the documented max (0-100_000)', () => {
    const orig = process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES']
    try {
      process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES'] = '999999999'
      const cfg = loadConfig()
      expect(cfg.hints.web_dedup_min_bytes).toBe(100_000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES']
      } else {
        process.env['TOKEN_GOAT_WEB_DEDUP_MIN_BYTES'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES', () => {
    const orig = process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES']
    try {
      process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES'] = '1234'
      const cfg = loadConfig()
      expect(cfg.hints.grep_dedup_min_matches).toBe(1234)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES']
      } else {
        process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES to the documented max (0-100_000)', () => {
    const orig = process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES']
    try {
      process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES'] = '999999999'
      const cfg = loadConfig()
      expect(cfg.hints.grep_dedup_min_matches).toBe(100_000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES']
      } else {
        process.env['TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_WEB_CACHE_MAX_FILES', () => {
    const orig = process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES']
    try {
      process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES'] = '1234'
      const cfg = loadConfig()
      expect(cfg.webfetch.max_file_count).toBe(1234)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES']
      } else {
        process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_WEB_CACHE_MAX_FILES to the documented max (0-10_000_000)', () => {
    const orig = process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES']
    try {
      process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES'] = '999999999999'
      const cfg = loadConfig()
      expect(cfg.webfetch.max_file_count).toBe(10_000_000)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES']
      } else {
        process.env['TOKEN_GOAT_WEB_CACHE_MAX_FILES'] = orig
      }
    }
  })

  it('applies env var override for TOKEN_GOAT_WEB_CACHE_MAX_BYTES', () => {
    const orig = process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES']
    try {
      process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES'] = '1234'
      const cfg = loadConfig()
      expect(cfg.webfetch.max_bytes).toBe(1234)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES']
      } else {
        process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES'] = orig
      }
    }
  })

  it('clamps an out-of-range env var override for TOKEN_GOAT_WEB_CACHE_MAX_BYTES to the documented max (0-100 * 1024 * 1024 * 1024)', () => {
    const orig = process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES']
    try {
      process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES'] = '999999999999999'
      const cfg = loadConfig()
      expect(cfg.webfetch.max_bytes).toBe(100 * 1024 * 1024 * 1024)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES']
      } else {
        process.env['TOKEN_GOAT_WEB_CACHE_MAX_BYTES'] = orig
      }
    }
  })
})

describe('ENV_KEYS registry (constants.ts)', () => {
  it('does not export a dead PREFER_AVIF entry (no feature ever reads it; removed from the canonical env-var registry)', () => {
    expect('PREFER_AVIF' in ENV_KEYS).toBe(false)
  })
})
