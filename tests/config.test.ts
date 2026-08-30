import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — this redirects configPath()/projectConfigPath() to per-test temp files.
// projectConfigPath() ignores its projectRoot argument entirely (same zero-arg-equivalent
// convention as configPath()), so tests don't need to control loadConfig()'s real cwd-based
// project-root resolution to exercise the per-project override layer.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    projectConfigPath: () => _testProjectConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-config-test.toml')
const _testProjectConfigPath = tempConfigPath('tg-project-config-test.toml')

import {
  defaultConfig,
  getLastConfigParseError,
  getLastProjectConfigParseError,
  getProjectConfigInfo,
  invalidateConfigCache,
  isAutoTriggerMultiplierExplicit,
  loadConfig,
  loadPersistedConfig,
  saveConfig,
} from '../src/config.js'
import { ENV_KEYS } from '../src/constants.js'
import { checkConfigValid } from '../src/cli_doctor.js'
import { cmdConfig } from '../src/config_commands.js'

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(_testProjectConfigPath)
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

  it('reads image_shrink.vision_tier, and ignores a value that is not one of the two tiers', () => {
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nvision_tier = "high"' + '\n', 'utf8')
    invalidateConfigCache()
    expect(loadConfig().image_shrink.vision_tier).toBe('high')

    // A typo or a stale name must not silently price every image on a tier nobody chose. There are
    // only two valid values and no sensible way to guess which was meant, so an unknown one falls
    // back to the default rather than being accepted or throwing.
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nvision_tier = "ultra"' + '\n', 'utf8')
    invalidateConfigCache()
    expect(loadConfig().image_shrink.vision_tier).toBe('standard')

    fs.writeFileSync(_testConfigPath, '[image_shrink]\nvision_tier = 47' + '\n', 'utf8')
    invalidateConfigCache()
    expect(loadConfig().image_shrink.vision_tier).toBe('standard')
  })

  it('lets TOKEN_GOAT_VISION_TIER override the configured tier', () => {
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nvision_tier = "standard"' + '\n', 'utf8')
    invalidateConfigCache()
    vi.stubEnv('TOKEN_GOAT_VISION_TIER', 'high')
    expect(loadConfig().image_shrink.vision_tier).toBe('high')

    invalidateConfigCache()
    vi.stubEnv('TOKEN_GOAT_VISION_TIER', 'nonsense')
    expect(loadConfig().image_shrink.vision_tier).toBe('standard')
    vi.unstubAllEnvs()
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

  it('clamps an out-of-range env var override for TOKEN_GOAT_EMBED_THREADS to the documented max (1-16)', () => {
    const orig = process.env['TOKEN_GOAT_EMBED_THREADS']
    try {
      process.env['TOKEN_GOAT_EMBED_THREADS'] = '999'
      expect(loadConfig().worker.embed_threads).toBe(16)
      process.env['TOKEN_GOAT_EMBED_THREADS'] = '0'
      expect(loadConfig().worker.embed_threads).toBe(1)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_EMBED_THREADS']
      } else {
        process.env['TOKEN_GOAT_EMBED_THREADS'] = orig
      }
    }
  })

  // The bounds and lock guards check that these keys are classified and reachable; neither looks at
  // the value. The value is the entire point: a default that drifts up to the core count restores
  // the behaviour the key was added to stop, and nothing would fail, because indexing still works
  // -- it just takes the machine again. Stated against os.cpus() rather than a bare number so this
  // keeps meaning "a small share of the host" on whatever CI runs it.
  it('defaults to a small fixed share of the host, not a host-sized thread pool', () => {
    const threads = defaultConfig().worker.embed_threads
    expect(threads).toBeGreaterThanOrEqual(1)
    expect(
      threads,
      `embed_threads defaults to ${threads} on a ${os.cpus().length}-core host; ONNX Runtime already ` +
        `defaults to a host-sized pool, so a default near the core count makes the setting pointless`,
    ).toBeLessThanOrEqual(4)
  })

  // Not a restatement of the bounds guard. The measurement behind the thread default is that
  // below_normal is what keeps the foreground responsive, not the thread count: the same foreground
  // probe that cannot tell 2, 4 or 6 threads apart from an idle machine reads -69% throughput and a
  // 292 ms stall at 4 threads on 2 cores the moment the priority is normal. Flipping this default
  // breaks nothing, fails no test, and indexing still works -- it just takes the machine again.
  it('defaults to a priority below normal, so indexing yields to the user', () => {
    expect(defaultConfig().worker.priority).toBe('below_normal')
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

  it('content-hash cache: a second write landing on the same mtime is still picked up (regression: the old mtime-only cache key silently served the first write forever once two writes shared an mtime tick)', () => {
    // Pin both writes to the exact same mtime (down to the same millisecond -- the resolution
    // utimesSync can actually set) so this reproduces the collision deterministically instead
    // of racing real filesystem timing.
    const pinnedMtime = new Date('2026-01-01T00:00:00.000Z')

    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')
    fs.utimesSync(_testConfigPath, pinnedMtime, pinnedMtime)
    const first = loadConfig()
    expect(first.compact_assist.min_events).toBe(4)

    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 9\n', 'utf8')
    fs.utimesSync(_testConfigPath, pinnedMtime, pinnedMtime)

    const second = loadConfig()
    expect(second.compact_assist.min_events).toBe(9)
    expect(second).not.toBe(first)
  })

  it('round-trips saveConfig → loadConfig with modified values', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.min_events = 7
    cfg.bash_compress.max_lines = 500
    cfg.hints.git_hint_max_ms = 99
    cfg.worker.blocked_roots = ['/tmp/blocked']
    cfg.image_shrink.jpeg_quality = 85
    cfg.image_shrink.ocr_enabled = false
    cfg.image_shrink.ocr_min_confidence = 80

    saveConfig(cfg)
    // saveConfig calls invalidateConfigCache internally
    const loaded = loadConfig()

    expect(loaded.compact_assist.min_events).toBe(7)
    expect(loaded.bash_compress.max_lines).toBe(500)
    expect(loaded.hints.git_hint_max_ms).toBe(99)
    expect(loaded.worker.blocked_roots).toEqual(['/tmp/blocked'])
    expect(loaded.image_shrink.jpeg_quality).toBe(85)
    expect(loaded.image_shrink.ocr_enabled).toBe(false)
    expect(loaded.image_shrink.ocr_min_confidence).toBe(80)
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

  it('treats a persisted large_read_redirect_bytes of exactly 45_000 as the stale pre-4b6f30dc default and falls through to the current default (512_000), instead of trusting it (regression: saveConfig always resaves every field, so a config set on any unrelated key before 4b6f30dc permanently persisted the then-in-memory-only 45_000 default, which 4b6f30dc later wired up as the real pressure-scaled first-read deny gate)', () => {
    fs.writeFileSync(_testConfigPath, '[hints]\nlarge_read_redirect_bytes = 45000\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.hints.large_read_redirect_bytes).toBe(512_000)
  })

  it('respects a persisted large_read_redirect_bytes that is not the legacy 45_000 sentinel (proving the fix only clobbers the exact stale default, not real user values)', () => {
    fs.writeFileSync(_testConfigPath, '[hints]\nlarge_read_redirect_bytes = 100000\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.hints.large_read_redirect_bytes).toBe(100000)
  })

  it('treats a persisted cache_min_bytes of exactly 0 as the stale pre-687758ae default and falls through to the current default (512), instead of trusting it (regression: saveConfig always resaves every field, so a config set on any unrelated key before 687758ae permanently persisted the then-in-memory-only 0 default, which 687758ae later wired up as the real cache minimum-size gate)', () => {
    fs.writeFileSync(_testConfigPath, '[bash_compress]\ncache_min_bytes = 0\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.bash_compress.cache_min_bytes).toBe(512)
  })

  it('respects a persisted cache_min_bytes that is not the legacy 0 sentinel (proving the fix only clobbers the exact stale default, not real user values)', () => {
    fs.writeFileSync(_testConfigPath, '[bash_compress]\ncache_min_bytes = 1024\n', 'utf8')
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.bash_compress.cache_min_bytes).toBe(1024)
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
// saveConfig omits an untouched auto_trigger_multiplier (#323 regression)
// ---------------------------------------------------------------------------

describe('saveConfig and auto_trigger_multiplier explicitness (#323 regression)', () => {
  beforeEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  })

  afterEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  })

  it('a saveConfig() for an unrelated key does not bake the still-default auto_trigger_multiplier into the raw TOML (regression: saveConfig always resaved every field, so isAutoTriggerMultiplierExplicit() returned true forever after any config set, permanently discarding the harness-tuned default multiplier)', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.min_events = 42 // an unrelated field -- this is the kind of save that used to clobber auto_trigger_multiplier's explicitness
    saveConfig(cfg)

    const raw = fs.readFileSync(_testConfigPath, 'utf8')
    expect(raw).not.toMatch(/auto_trigger_multiplier/)
    expect(isAutoTriggerMultiplierExplicit()).toBe(false)
  })

  it('a saveConfig() preserves an explicitly-set non-default auto_trigger_multiplier', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nauto_trigger_multiplier = 3.5\n', 'utf8')
    invalidateConfigCache()
    expect(isAutoTriggerMultiplierExplicit()).toBe(true)

    const cfg = defaultConfig()
    cfg.compact_assist.auto_trigger_multiplier = 3.5
    cfg.compact_assist.min_events = 42 // unrelated save, should not lose the explicit multiplier
    saveConfig(cfg)

    const raw = fs.readFileSync(_testConfigPath, 'utf8')
    expect(raw).toMatch(/auto_trigger_multiplier\s*=\s*3\.5/)
    expect(isAutoTriggerMultiplierExplicit()).toBe(true)
    expect(loadConfig().compact_assist.auto_trigger_multiplier).toBe(3.5)
  })

  it('a saveConfig() writes the key when the user explicitly sets the default value itself (2.0 written on purpose is not indistinguishable from never-touched, once isAutoTriggerMultiplierExplicit() already saw it explicit pre-save)', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nauto_trigger_multiplier = 2.0\n', 'utf8')
    invalidateConfigCache()
    expect(isAutoTriggerMultiplierExplicit()).toBe(true)

    const cfg = defaultConfig()
    cfg.compact_assist.min_events = 42
    saveConfig(cfg)

    const raw = fs.readFileSync(_testConfigPath, 'utf8')
    expect(raw).toMatch(/auto_trigger_multiplier/)
    expect(isAutoTriggerMultiplierExplicit()).toBe(true)
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

  it('loadPersistedConfig() ignores a transient TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES env override instead of baking it into the persisted-on-disk view (regression: withoutConfigEnv only cleared its hand-maintained ENV_KEYS list, which omitted this var, so an env override active for the current invocation leaked through and would get permanently written to config.toml by a `config set` on any unrelated key)', () => {
    const orig = process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
    try {
      process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'] = '4321'
      const cfg = loadPersistedConfig()
      expect(cfg.hints.glob_dedup_min_matches).toBe(defaultConfig().hints.glob_dedup_min_matches)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
      } else {
        process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'] = orig
      }
    }
  })

  it('loadPersistedConfig() ignores a transient TOKEN_GOAT_OCR_ENABLED env override instead of baking it into the persisted-on-disk view (regression: same withoutConfigEnv omission as glob_dedup_min_matches above)', () => {
    const orig = process.env['TOKEN_GOAT_OCR_ENABLED']
    try {
      const defaultOcrEnabled = defaultConfig().image_shrink.ocr_enabled
      process.env['TOKEN_GOAT_OCR_ENABLED'] = defaultOcrEnabled ? 'false' : 'true'
      const cfg = loadPersistedConfig()
      expect(cfg.image_shrink.ocr_enabled).toBe(defaultOcrEnabled)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_OCR_ENABLED']
      } else {
        process.env['TOKEN_GOAT_OCR_ENABLED'] = orig
      }
    }
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
    expect(cfg.hints.serve_diff_on_reread).toBe(true)
  })

  it('ImageShrinkConfig defaults', () => {
    const cfg = defaultConfig()
    expect(cfg.image_shrink.jpeg_quality).toBe(75)
    expect(cfg.image_shrink.max_image_pixels).toBe(16_000_000)
    expect(cfg.image_shrink.screenshot_redirect).toBe(true)
    expect(cfg.image_shrink.ocr_enabled).toBe(true)
    expect(cfg.image_shrink.ocr_min_confidence).toBe(65)
    // The floor of the two billing tiers, on purpose. Reporting a saving against the cheaper of the
    // two bills can never credit one that was not there; the other direction is the over-credit
    // class this repository has shipped repeatedly.
    expect(cfg.image_shrink.vision_tier).toBe('standard')
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

  it('applies env var override for TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES', () => {
    const orig = process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
    try {
      process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'] = '1234'
      const cfg = loadConfig()
      expect(cfg.hints.glob_dedup_min_matches).toBe(1234)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
      } else {
        process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'] = orig
      }
    }
  })

  it('picks up a mid-process change to TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES without an explicit invalidateConfigCache() call (regression: configEnvFingerprint\'s hand-maintained ENV_KEYS list omitted this var, so loadConfig()\'s cache never saw the change and kept serving the stale value)', () => {
    const orig = process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
    try {
      delete process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
      const before = loadConfig()
      expect(before.hints.glob_dedup_min_matches).toBe(5)
      process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'] = '4321'
      const after = loadConfig()
      expect(after.hints.glob_dedup_min_matches).toBe(4321)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES']
      } else {
        process.env['TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES'] = orig
      }
    }
  })

  // The static guard in tests/guards/hints_env_override_coverage.test.ts proves each new env override LINE exists; these prove the vars actually reach loadConfig() at runtime, one per helper type (envInt/envBool/envStr), including the cache-fingerprint path the earlier ENV_KEYS drift broke.
  function withEnv<T>(key: string, value: string, fn: () => T): T {
    const orig = process.env[key]
    try {
      process.env[key] = value
      return fn()
    } finally {
      if (orig === undefined) delete process.env[key]
      else process.env[key] = orig
    }
  }

  it('TOKEN_GOAT_PROTECT_RECENT_READS overrides hints.protect_recent_reads (envInt)', () => {
    expect(loadConfig().hints.protect_recent_reads).toBe(4)
    withEnv('TOKEN_GOAT_PROTECT_RECENT_READS', '0', () => {
      expect(loadConfig().hints.protect_recent_reads).toBe(0)
    })
    // Restoring the env must restore the value, proving the cache fingerprint tracks this var in both directions rather than latching the override.
    expect(loadConfig().hints.protect_recent_reads).toBe(4)
  })

  it('TOKEN_GOAT_REREAD_DENY overrides hints.reread_deny (envBool)', () => {
    const dflt = loadConfig().hints.reread_deny
    withEnv('TOKEN_GOAT_REREAD_DENY', dflt ? 'false' : 'true', () => {
      expect(loadConfig().hints.reread_deny).toBe(!dflt)
    })
    expect(loadConfig().hints.reread_deny).toBe(dflt)
  })

  it('TOKEN_GOAT_QUIET_HOURS overrides hints.quiet_hours (envStr)', () => {
    withEnv('TOKEN_GOAT_QUIET_HOURS', '22-06', () => {
      expect(loadConfig().hints.quiet_hours).toBe('22-06')
    })
  })

  it('picks up a mid-process change to TOKEN_GOAT_OCR_ENABLED without an explicit invalidateConfigCache() call (regression: same ENV_KEYS omission as glob_dedup_min_matches above)', () => {
    const orig = process.env['TOKEN_GOAT_OCR_ENABLED']
    try {
      delete process.env['TOKEN_GOAT_OCR_ENABLED']
      const before = loadConfig()
      const defaultOcrEnabled = before.image_shrink.ocr_enabled
      process.env['TOKEN_GOAT_OCR_ENABLED'] = defaultOcrEnabled ? 'false' : 'true'
      const after = loadConfig()
      expect(after.image_shrink.ocr_enabled).toBe(!defaultOcrEnabled)
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_OCR_ENABLED']
      } else {
        process.env['TOKEN_GOAT_OCR_ENABLED'] = orig
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

// ---------------------------------------------------------------------------
// Per-project .token-goat.toml override (#306)
// ---------------------------------------------------------------------------

describe('per-project .token-goat.toml override', () => {
  beforeEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  })

  afterEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
    vi.restoreAllMocks()
  })

  it('falls back to global-only behavior unchanged when no .token-goat.toml is present (regression: existing behavior)', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(4)
    expect(getProjectConfigInfo()).toBeNull()
    expect(getLastProjectConfigParseError()).toBeNull()
  })

  it('a valid .token-goat.toml overriding one known key changes that key\'s effective value', () => {
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 9\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(9)
  })

  it('per-project file overriding a value also set in the global file: per-project wins', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 9\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(9)
  })

  it('per-project file setting one key in a section leaves sibling keys in that section inherited from the global file (field-level merge, not whole-section replace)', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\nmax_manifest_tokens = 700\n', 'utf8')
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 9\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(9)
    expect(cfg.compact_assist.max_manifest_tokens).toBe(700)
  })

  it('an unknown key in .token-goat.toml is ignored, same as an unknown key in the global config.toml', () => {
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nnot_a_real_key = 123\nmin_events = 6\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(6)
    expect(Object.hasOwn(cfg.compact_assist, 'not_a_real_key')).toBe(false)
  })

  it('an unknown section in .token-goat.toml is ignored, same as an unknown section in the global config.toml', () => {
    fs.writeFileSync(_testProjectConfigPath, '[not_a_real_section]\nfoo = 1\n\n[compact_assist]\nmin_events = 6\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(6)
    expect(Object.hasOwn(cfg, 'not_a_real_section')).toBe(false)
  })

  it('a malformed .token-goat.toml fails open: global config still loads, and the parse error is reported separately from the global one', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')
    fs.writeFileSync(_testProjectConfigPath, 'this is not [ valid toml ===\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(4)
    expect(getLastConfigParseError()).toBeNull()
    expect(getLastProjectConfigParseError()).not.toBeNull()
  })

  it('an out-of-bounds value in .token-goat.toml is clamped/rejected the same way an out-of-bounds value in the global config is', () => {
    // compact_assist.min_events bounds are [0, 1000] (NUMERIC_FIELD_BOUNDS in config.ts).
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 999999\n', 'utf8')
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(1000)
  })

  it('an env var override wins over both the global file and the per-project file', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nenabled = true\n', 'utf8')
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nenabled = true\n', 'utf8')
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

  it('cache: a change to the per-project file (with the global file and env unchanged) is picked up on the next loadConfig() after invalidateConfigCache()', () => {
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 3\n', 'utf8')
    const first = loadConfig()
    expect(first.compact_assist.min_events).toBe(3)

    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 8\n', 'utf8')
    invalidateConfigCache()
    const second = loadConfig()
    expect(second.compact_assist.min_events).toBe(8)
    expect(second).not.toBe(first)
  })

  it('getProjectConfigInfo() reports the overridden dotted keys for the config-list display', () => {
    fs.writeFileSync(_testProjectConfigPath, '[compact_assist]\nmin_events = 6\n\n[hints]\ngit_hint_max_ms = 5\n', 'utf8')
    const info = getProjectConfigInfo()
    expect(info).not.toBeNull()
    expect(info?.keys).toEqual(expect.arrayContaining(['compact_assist.min_events', 'hints.git_hint_max_ms']))
    expect(info?.parseError).toBeNull()
  })

  it('getProjectConfigInfo() returns null when no .token-goat.toml exists', () => {
    expect(getProjectConfigInfo()).toBeNull()
  })

  it('does not break existing zero-arg loadConfig() callers (signature stays backward compatible)', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 4\n', 'utf8')
    // Called exactly as every pre-existing caller in src/ calls it -- no args.
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(4)
  })
})

// A config file carries whatever byte-order mark the editor that wrote it left behind. These
// files were read as raw UTF-8, so the mark became part of the first key name and the whole file
// failed to parse -- every setting in it silently ignored, with an error naming a key nobody
// wrote. "UTF-8 with BOM" is an ordinary editor setting, and UTF-16 with a mark is what Windows
// PowerShell 5.1 writes for a plain `>` redirect, which is this program's main platform.
describe('a config file written with a byte-order mark', () => {
  beforeEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  })

  afterEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  })

  const TOML = '[hints]\nmcp_dedup_ttl_secs = 77\n'

  it.each([
    ['UTF-8 with a mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TOML, 'utf8')])],
    ['UTF-16LE with a mark', Buffer.from(`\uFEFF${TOML}`, 'utf16le')],
    ['UTF-8 with no mark', Buffer.from(TOML, 'utf8')],
  ])('reads the global config written as %s', (_label, bytes) => {
    fs.writeFileSync(_testConfigPath, bytes)

    expect(loadConfig().hints.mcp_dedup_ttl_secs).toBe(77)
    expect(getLastConfigParseError()).toBeNull()
  })

  it('reads a per-project file written with a mark, and still refuses its locked keys', () => {
    fs.writeFileSync(
      _testProjectConfigPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('[hints]\nmcp_dedup_ttl_secs = 88\n\n[injection]\nenabled = false\n', 'utf8'),
      ]),
    )
    const cfg = loadConfig()

    expect(cfg.hints.mcp_dedup_ttl_secs).toBe(88)
    expect(cfg.injection.enabled).toBe(true)
    expect(getLastProjectConfigParseError()).toBeNull()
  })

  // `doctor` and `config validate` each opened the file with a raw 'utf8' read of their own
  // rather than the loader's decoder, so a BOM'd config produced two answers in one process: the
  // loader applied every setting in it while doctor printed "[FAIL] Config: config invalid" and
  // validate told the user to go fix a file that was working. That inversion is worse than the
  // original defect -- it sends someone editing a healthy file. Whatever reads a config must
  // reach the loader's verdict about it.
  it.each([
    ['UTF-8 with a mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TOML, 'utf8')])],
    ['UTF-16LE with a mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TOML, 'utf16le')])],
    ['UTF-8 with no mark', Buffer.from(TOML, 'utf8')],
  ])('has doctor agree with the loader about a config written as %s', (_label, bytes) => {
    fs.writeFileSync(_testConfigPath, bytes)

    // The loader's verdict, then doctor's, on the very same bytes.
    expect(loadConfig().hints.mcp_dedup_ttl_secs).toBe(77)
    expect(checkConfigValid(_testConfigPath).status).toBe('ok')
  })

  it.each([
    ['UTF-8 with a mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TOML, 'utf8')])],
    ['UTF-16LE with a mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TOML, 'utf16le')])],
    ['UTF-8 with no mark', Buffer.from(TOML, 'utf8')],
  ])('has config validate agree with the loader about a config written as %s', (_label, bytes) => {
    // The same defect lived at two sites; covering only one of them would repeat exactly the
    // "fixed here, missed there" mistake that produced it.
    fs.writeFileSync(_testConfigPath, bytes)
    expect(loadConfig().hints.mcp_dedup_ttl_secs).toBe(77)

    let out = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk)
      return true
    })
    try {
      cmdConfig({ action: 'validate', json: true })
    } finally {
      write.mockRestore()
    }

    expect((JSON.parse(out) as { findings: unknown[] }).findings).toEqual([])
  })

  it('still has doctor report a genuinely malformed BOM-prefixed file as failing', () => {
    // The agreement above must not come from doctor having stopped checking.
    fs.writeFileSync(_testConfigPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[hints\n', 'utf8')]))

    expect(checkConfigValid(_testConfigPath).status).toBe('fail')
  })

  it('still reports a genuinely malformed file as a parse error rather than swallowing it', () => {
    fs.writeFileSync(_testConfigPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[hints\n', 'utf8')]))

    loadConfig()

    expect(getLastConfigParseError()).not.toBeNull()
  })
})
