import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — this redirects configPath() to a per-test-file temp file
// so storeBlob/pruneBlobs's new config-driven eviction limits (bash_compress /
// webfetch) can be exercised deterministically, independent of the shared
// per-worker DATA_DIR other test files write to. Mirrors tests/config.test.ts.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

// vi.mock is hoisted — wraps the real redactSecrets in a spy (calls through by
// default) so tests can both assert it ran and force a one-off throw to exercise
// storeBlob()'s fail-safe path, without duplicating the real redaction logic.
vi.mock('../src/secret_redact.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['redactSecrets'] as (text: string) => { text: string; count: number }
  return {
    ...original,
    redactSecrets: vi.fn((text: string) => real(text)),
  }
})

// vi.mock is hoisted — wraps the real recordStat in a spy (calls through by
// default) so tests can assert a 'secret_redacted' stat fired without needing a
// real global.db fixture. Mirrors tests/hooks_glob.test.ts's recordStat spy.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return {
    ...original,
    recordStat: vi.fn((...args: unknown[]) => real(...args)),
  }
})

const _testConfigPath = tempConfigPath('tg-disk-cache-config-test.toml')

import { storeBlob, loadBlob, pruneBlobs, tokenGoatHome } from '../src/disk_cache.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { redactSecrets } from '../src/secret_redact.js'
import { recordStat, kindToSource, SOURCE_OTHER } from '../src/stats.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-blob-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  vi.mocked(redactSecrets).mockClear()
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  invalidateConfigCache()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ok — may not exist
  }
})

afterAll(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ignore
  }
})

describe('tokenGoatHome', () => {
  it('honors the TOKEN_GOAT_HOME override', () => {
    expect(tokenGoatHome()).toBe(tmpHome)
  })

  it('falls back to ~/.token-goat when the override is unset', () => {
    delete process.env['TOKEN_GOAT_HOME']
    expect(tokenGoatHome()).toBe(path.join(os.homedir(), '.token-goat'))
  })

  it('treats an empty override as unset', () => {
    process.env['TOKEN_GOAT_HOME'] = ''
    expect(tokenGoatHome()).toBe(path.join(os.homedir(), '.token-goat'))
  })
})

describe('storeBlob / loadBlob', () => {
  it('round-trips a value through disk', () => {
    expect(storeBlob('sub', 'abc123', { hello: 'world', n: 7 })).toBe(true)
    expect(loadBlob('sub', 'abc123')).toEqual({ hello: 'world', n: 7 })
  })

  it('writes under <home>/<subdir>/<id>.json', () => {
    storeBlob('bash_outputs', 'deadbeef', { x: 1 })
    expect(fs.existsSync(path.join(tmpHome, 'bash_outputs', 'deadbeef.json'))).toBe(true)
  })

  it('returns null for a missing id', () => {
    expect(loadBlob('sub', 'nope')).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    const dir = path.join(tmpHome, 'sub')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8')
    expect(loadBlob('sub', 'broken')).toBeNull()
  })

  it('rejects ids that sanitize to empty (no write, no path escape)', () => {
    expect(storeBlob('sub', '', { x: 1 })).toBe(false)
    expect(storeBlob('sub', '///', { x: 1 })).toBe(true) // sanitizes to "___", a safe stem
    expect(loadBlob('sub', '///')).toEqual({ x: 1 })
  })

  it('does not let a traversal id escape the subdir', () => {
    // '..' sanitizes to '__' so it cannot climb out; the file lands inside sub.
    storeBlob('sub', '../evil', { x: 1 })
    expect(fs.existsSync(path.join(path.dirname(tmpHome), 'evil.json'))).toBe(false)
  })
})

describe('pruneBlobs', () => {
  it('drops blobs older than maxAgeMs', () => {
    // Store both first (each store's own prune sees them as fresh), then backdate 'old' so the explicit prune is what evicts it.
    storeBlob('sub', 'old', { x: 1 })
    storeBlob('sub', 'fresh', { x: 2 })
    const oldPath = path.join(tmpHome, 'sub', 'old.json')
    const past = Date.now() - 48 * 3600 * 1000
    fs.utimesSync(oldPath, new Date(past), new Date(past))
    const removed = pruneBlobs('sub', 200, 24 * 3600 * 1000)
    // Exactly one blob ('old') is backdated past the 24h maxAge; 'fresh' stays.
    expect(removed).toBe(1)
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(loadBlob('sub', 'fresh')).toEqual({ x: 2 })
  })

  it('evicts the oldest beyond maxCount', () => {
    // Stamp distinct mtimes so eviction order is deterministic.
    for (let i = 0; i < 5; i++) {
      storeBlob('sub', `id${i}`, { i }, { maxCount: 1000 })
      const p = path.join(tmpHome, 'sub', `id${i}.json`)
      const t = new Date(Date.now() - (5 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    pruneBlobs('sub', 2, 24 * 3600 * 1000)
    const remaining = fs.readdirSync(path.join(tmpHome, 'sub')).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(2)
    // The two newest (id3, id4) survive.
    expect(remaining.sort()).toEqual(['id3.json', 'id4.json'])
  })

  it('returns 0 for a missing subdir', () => {
    expect(pruneBlobs('never', 10, 1000)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Config-driven eviction limits (bash_compress.cache_max_file_count /
// cache_max_bytes / cache_max_bytes_per_output, webfetch.max_file_count /
// max_bytes). Before this fix, storeBlob always called pruneBlobs with the
// hardcoded DEFAULT_MAX_COUNT (200) and no byte budget at all — these knobs
// were validated and saved by config.ts but had zero effect on real eviction.
// ---------------------------------------------------------------------------
describe('storeBlob — config-driven cache limits for bash_outputs/web_outputs', () => {
  it('evicts down to a configured bash_compress.cache_max_file_count well below the old hardcoded 200 default', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_max_file_count = 3
    saveConfig(cfg)

    for (let i = 0; i < 6; i++) {
      storeBlob('bash_outputs', `id${i}`, { i })
      const p = path.join(tmpHome, 'bash_outputs', `id${i}.json`)
      const t = new Date(Date.now() - (6 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    const remaining = fs.readdirSync(path.join(tmpHome, 'bash_outputs')).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(3)
    expect(remaining.sort()).toEqual(['id3.json', 'id4.json', 'id5.json'])
  })

  it('evicts down to a configured webfetch.max_file_count well below the old hardcoded 200 default', () => {
    const cfg = defaultConfig()
    cfg.webfetch.max_file_count = 2
    saveConfig(cfg)

    for (let i = 0; i < 5; i++) {
      storeBlob('web_outputs', `w${i}`, { url: `https://example.com/${i}`, content: 'x' })
      const p = path.join(tmpHome, 'web_outputs', `w${i}.json`)
      const t = new Date(Date.now() - (5 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    const remaining = fs.readdirSync(path.join(tmpHome, 'web_outputs')).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(2)
    expect(remaining.sort()).toEqual(['w3.json', 'w4.json'])
  })

  it('evicts by total bytes when a configured bash_compress.cache_max_bytes budget is exceeded (previously unenforced — no total-byte cap existed at all)', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_max_file_count = 1_000_000 // isolate the byte-budget path from the count cap
    cfg.bash_compress.cache_max_bytes = 1024 // config.ts's validated floor for this field
    saveConfig(cfg)

    // Each stored value serializes to ~170 bytes; ten of them clear the 1024-byte budget.
    for (let i = 0; i < 10; i++) {
      storeBlob('bash_outputs', `big${i}`, { payload: 'x'.repeat(150), i })
      const p = path.join(tmpHome, 'bash_outputs', `big${i}.json`)
      const t = new Date(Date.now() - (10 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    const dir = path.join(tmpHome, 'bash_outputs')
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(remaining.length).toBeLessThan(10)
    const totalBytes = remaining.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0)
    expect(totalBytes).toBeLessThanOrEqual(1024)
    // The most recent entry must survive (oldest-first eviction).
    expect(remaining).toContain('big9.json')
  })

  it('refuses to persist a single output larger than a configured bash_compress.cache_max_bytes_per_output (previously no per-item ceiling existed)', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_max_bytes_per_output = 1024 // config.ts's validated floor for this field
    saveConfig(cfg)

    const smallOk = storeBlob('bash_outputs', 'small', { payload: 'x'.repeat(10) })
    const tooBig = storeBlob('bash_outputs', 'toobig', { payload: 'x'.repeat(2000) })

    expect(smallOk).toBe(true)
    expect(tooBig).toBe(false)
    expect(loadBlob('bash_outputs', 'small')).not.toBeNull()
    expect(loadBlob('bash_outputs', 'toobig')).toBeNull()
  })

  it('a subdir with no dedicated config section (e.g. skills) keeps the generic DEFAULT_MAX_COUNT behavior unchanged', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_max_file_count = 2 // must not leak into an unrelated subdir
    saveConfig(cfg)

    for (let i = 0; i < 5; i++) {
      storeBlob('some_other_cache', `o${i}`, { i }, { maxCount: 1000 })
    }
    const remaining = fs.readdirSync(path.join(tmpHome, 'some_other_cache')).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(5) // nothing evicted — well under the generic 200 default
  })
})

// Regression coverage for a bug where storeBlob() reported success (`true`) for a
// blob that was written to disk and then immediately deleted again by its own
// pruneBlobs() call, whenever cache_max_bytes_per_output (per-item ceiling) was
// configured larger than cache_max_bytes (total-directory budget) — the item
// would pass the per-item check, get written, then get evicted oldest-first by
// the byte-budget pass because nothing protected "the item this same call just
// wrote" from its own eviction sweep. Fixed two ways: config.ts now clamps
// cache_max_bytes_per_output down to cache_max_bytes so the misconfiguration
// can't happen via config; pruneBlobs() also now never evicts the blob the
// current storeBlob() call just wrote, as defense in depth for callers that
// bypass config validation via storeBlob()'s own maxBytes/maxBytesPerItem opts.
describe('storeBlob — does not self-evict the blob it just wrote', () => {
  it('config.ts clamps cache_max_bytes_per_output <= cache_max_bytes, so a misconfigured per-item ceiling larger than the total budget is rejected up front instead of silently wiped after writing', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_max_bytes = 1024 // total-directory budget
    cfg.bash_compress.cache_max_bytes_per_output = 4096 // per-item ceiling — larger than the total budget
    saveConfig(cfg)

    // Serializes to well over 1024 bytes but under the (unclamped) 4096 per-item ceiling.
    const ok = storeBlob('bash_outputs', 'victim', { payload: 'x'.repeat(1500) })

    expect(ok).toBe(false)
    expect(loadBlob('bash_outputs', 'victim')).toBeNull()
    const dir = path.join(tmpHome, 'bash_outputs')
    const remaining = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
    expect(remaining).toHaveLength(0)
  })

  it('pruneBlobs() protects the just-written blob from its own byte-budget eviction pass even when maxBytesPerItem > maxBytes is set directly via storeBlob() opts, bypassing config validation entirely', () => {
    const ok = storeBlob('bash_outputs', 'victim2', { payload: 'x'.repeat(1500) }, { maxBytes: 1024, maxBytesPerItem: 4096 })

    expect(ok).toBe(true)
    expect(loadBlob('bash_outputs', 'victim2')).not.toBeNull()
  })
})

// Coverage for the redaction pass wired into storeBlob() (src/disk_cache.ts) as
// the single choke point every blob-persisting caller (bash-output, web-output,
// mcp-output) funnels through — see src/secret_redact.ts.
describe('storeBlob — secret redaction choke point', () => {
  const fakeAws = 'AKIA' + 'IOSFODNN7EXAMPLE'
  it('redacts a secret before it ever reaches disk', () => {
    const ok = storeBlob('bash_outputs', 'secret1', {
      stdout: `AWS_ACCESS_KEY_ID=${fakeAws}`,
    })

    expect(ok).toBe(true)
    const loaded = loadBlob('bash_outputs', 'secret1') as { stdout: string }
    expect(loaded.stdout).toBe('AWS_ACCESS_KEY_ID=[REDACTED:aws_access_key]')
    expect(loaded.stdout).not.toContain(fakeAws)

    // The raw bytes on disk never contain the secret either — not just the
    // parsed-back value.
    const p = path.join(tmpHome, 'bash_outputs', 'secret1.json')
    const raw = fs.readFileSync(p, 'utf8')
    expect(raw).not.toContain(fakeAws)
  })

  it('leaves content with no secrets byte-for-byte unmodified', () => {
    const value = { stdout: 'Build succeeded. 3 files changed.', exitCode: 0 }
    const ok = storeBlob('bash_outputs', 'nosecret', value)

    expect(ok).toBe(true)
    expect(loadBlob('bash_outputs', 'nosecret')).toEqual(value)
    const p = path.join(tmpHome, 'bash_outputs', 'nosecret.json')
    expect(fs.readFileSync(p, 'utf8')).toBe(JSON.stringify(value))
  })

  it('redacts multiple distinct secrets within one blob and leaves the rest intact', () => {
    const fakeGhp = 'ghp_' + '123456789012345678901234567890123456'
    const ok = storeBlob('web_outputs', 'multi', {
      content:
        `env dump:\nAWS_ACCESS_KEY_ID=${fakeAws}\nGITHUB_TOKEN=${fakeGhp}\ndone.`,
    })

    expect(ok).toBe(true)
    const loaded = loadBlob('web_outputs', 'multi') as { content: string }
    expect(loaded.content).toBe(
      'env dump:\nAWS_ACCESS_KEY_ID=[REDACTED:aws_access_key]\nGITHUB_TOKEN=[REDACTED:github_token]\ndone.',
    )
  })

  it('records a secret_redacted stat when redaction fires, and that kind is registered in stats.ts (KIND_TO_SOURCE)', () => {
    const fakeAws = 'AKIA' + 'IOSFODNN7EXAMPLE'
    storeBlob('bash_outputs', 'stat1', { stdout: fakeAws })

    const call = vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'secret_redacted')
    expect(call).toBeDefined()
    // Never left unregistered in KIND_TO_SOURCE -- a recurring bug class in this
    // codebase per CLAUDE.md. Falling through to the generic default (SOURCE_OTHER)
    // silently for an unregistered kind would also pass this loose an assertion,
    // so assert the kind resolves to the intentionally-chosen source rather than
    // merely "some source".
    expect(kindToSource('secret_redacted')).toBe(SOURCE_OTHER)
  })

  it('does not record a stat when a blob has no secrets', () => {
    storeBlob('bash_outputs', 'stat2', { stdout: 'nothing to see here' })

    const call = vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'secret_redacted')
    expect(call).toBeUndefined()
  })

  it('fails safe (skips caching this blob) when the redaction pass itself throws', () => {
    vi.mocked(redactSecrets).mockImplementationOnce(() => {
      throw new Error('boom')
    })

    const ok = storeBlob('bash_outputs', 'redaction-failure', { stdout: fakeAws })

    expect(ok).toBe(false)
    expect(loadBlob('bash_outputs', 'redaction-failure')).toBeNull()
    const dir = path.join(tmpHome, 'bash_outputs')
    const remaining = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
    expect(remaining).toHaveLength(0)
  })

  it('returns false instead of throwing when the value cannot be serialized to JSON', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular['self'] = circular

    expect(() => storeBlob('bash_outputs', 'circular', circular)).not.toThrow()
    expect(storeBlob('bash_outputs', 'circular', circular)).toBe(false)
    expect(loadBlob('bash_outputs', 'circular')).toBeNull()
  })

  it('returns false instead of throwing on a BigInt, which JSON.stringify rejects outright', () => {
    expect(() => storeBlob('bash_outputs', 'bigint', { count: 1n })).not.toThrow()
    expect(storeBlob('bash_outputs', 'bigint', { count: 1n })).toBe(false)
    expect(loadBlob('bash_outputs', 'bigint')).toBeNull()
  })

  it('recovers on the next call after a one-off redaction failure (the mocked throw does not persist)', () => {
    vi.mocked(redactSecrets).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(storeBlob('bash_outputs', 'recover1', { stdout: fakeAws })).toBe(false)

    const ok = storeBlob('bash_outputs', 'recover2', { stdout: fakeAws })
    expect(ok).toBe(true)
    const loaded = loadBlob('bash_outputs', 'recover2') as { stdout: string }
    expect(loaded.stdout).toBe('[REDACTED:aws_access_key]')
  })
})
