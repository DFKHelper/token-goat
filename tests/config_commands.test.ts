/**
 * Unit tests for D3 commands: config, project, compact-doc, fetch-image, history.
 *
 * config set→get round-trip is the mutation-verify target (break nested-set → test fails).
 * All config tests use a vi.mock redirect of configPath() to an isolated temp file.
 * All project/history tests use TOKEN_GOAT_HOME for disk_cache isolation.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as WebfetchModule from '../src/webfetch.js'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const performHttpFetchMock = vi.hoisted(() => vi.fn())

// vi.mock is hoisted — redirect configPath() for config tests.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

// vi.mock is hoisted — stub webfetch.js's performHttpFetch so fetch-image tests can control
// the response without opening a real socket. Mirrors tests/webfetch.test.ts's dnsLookupMock
// convention: by default this delegates straight through to the real implementation, so any
// test that doesn't layer a mockImplementationOnce on top -- including the SSRF-rejection
// test below, which needs the real ssrfPinnedLookup to run -- gets real behavior for free.
vi.mock('../src/webfetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WebfetchModule>()
  performHttpFetchMock.mockImplementation(
    (url: string, opts: Parameters<typeof actual.performHttpFetch>[1]) => actual.performHttpFetch(url, opts),
  )
  return { ...actual, performHttpFetch: performHttpFetchMock }
})

const _testConfigPath = path.join(os.tmpdir(), `tg-cfgcmd-test-${process.pid}.toml`)

import { cmdConfig, cmdProject, cmdCompactDoc, cmdHistory, cmdFetchImage } from '../src/config_commands.js'
import { compactPathFor, isCompactFresh } from '../src/doc_compact.js'
import { invalidateConfigCache, loadConfig, saveConfig, defaultConfig } from '../src/config.js'
import { storeBlob } from '../src/disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from '../src/bash_output_cache.js'
import { WEB_OUTPUT_SUBDIR } from '../src/web_cache.js'

// ── Setup/teardown ──────────────────────────────────────────────────────────

let tmpHome: string
let prevHome: string | undefined
let stdoutLines: string[]
let stderrLines: string[]
let writeSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfgcmd-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  stdoutLines = []
  stderrLines = []
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutLines.push(String(chunk))
    return true
  })
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrLines.push(String(chunk))
    return true
  })
  invalidateConfigCache()
  try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
})

afterEach(() => {
  writeSpy.mockRestore()
  errSpy.mockRestore()
  invalidateConfigCache()
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ok */ }
})

afterAll(() => {
  try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
})

function captured(): string { return stdoutLines.join('') }
function capturedErr(): string { return stderrLines.join('') }

// ── config list ──────────────────────────────────────────────────────────────

describe('cmdConfig list', () => {
  it('emits flat key=value pairs covering known top-level sections', () => {
    cmdConfig({ action: 'list' })
    const out = captured()
    expect(out).toContain('compact_assist.enabled')
    expect(out).toContain('worker.blocked_roots')
  })

  it('--json outputs a valid object with expected top-level keys', () => {
    cmdConfig({ action: 'list', json: true })
    const parsed = JSON.parse(captured()) as Record<string, unknown>
    expect(typeof parsed['compact_assist']).toBe('object')
    expect(typeof parsed['worker']).toBe('object')
  })
})

// ── config get ───────────────────────────────────────────────────────────────

describe('cmdConfig get', () => {
  it('returns the value for a known key', () => {
    cmdConfig({ action: 'get', key: 'compact_assist.enabled' })
    expect(captured()).toContain('true')
  })

  it('returns array as JSON for array-typed keys', () => {
    cmdConfig({ action: 'get', key: 'compact_assist.triggers' })
    const out = captured().trim()
    const parsed = JSON.parse(out) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
  })

  it('throws and emits stderr for an unknown key', () => {
    expect(() => cmdConfig({ action: 'get', key: 'no_such_section.foo' })).toThrow()
    expect(capturedErr()).toContain('key not found')
  })

  it('throws when key is missing', () => {
    expect(() => cmdConfig({ action: 'get' })).toThrow()
  })
})

// ── config set → get round-trip (mutation-verify target) ─────────────────────

describe('cmdConfig set', () => {
  it('round-trip: set a value then get it back', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '99' })
    invalidateConfigCache()
    cmdConfig({ action: 'get', key: 'compact_assist.min_events' })
    expect(captured()).toContain('99')
  })

  it('coerces boolean values correctly', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'false' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.enabled).toBe(false)
  })

  it('throws on invalid boolean values', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'True' })).toThrow()
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'yes' })).toThrow()
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'maybe' })).toThrow()
  })

  it('coerces number values correctly', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.max_manifest_tokens', value: '777' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.max_manifest_tokens).toBe(777)
  })

  it('persists the change to disk (verifying nested-set actually writes)', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '42' })
    const raw = fs.readFileSync(_testConfigPath, 'utf8')
    expect(raw).toContain('min_events')
  })

  it('throws and emits stderr for an unknown key', () => {
    expect(() => cmdConfig({ action: 'set', key: 'no_such.key', value: 'x' })).toThrow()
    expect(capturedErr()).toContain('key not found')
  })

  it('throws when key is missing', () => {
    expect(() => cmdConfig({ action: 'set' })).toThrow()
  })

  it('throws when value is missing', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled' })).toThrow()
  })

  it('--json returns the set value', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '7', json: true })
    const parsed = JSON.parse(captured()) as { key: string; value: unknown }
    expect(parsed.key).toBe('compact_assist.min_events')
    expect(parsed.value).toBe(7)
  })

  it('restores default after mutation-verify test', () => {
    const def = defaultConfig()
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: String(def.compact_assist.min_events) })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(def.compact_assist.min_events)
  })
})

// ── config set input validation hardening (#M23, #M24, #M28) ────────────────

describe('cmdConfig set input validation hardening', () => {
  it('coerces a comma-separated number list into actual numbers, not strings (#M23)', () => {
    cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '1,3,10' })
    invalidateConfigCache()
    const cfg = loadConfig()
    // Pre-fix, the comma-split segments stayed strings and the load-time int-list validator
    // silently filtered them all out, leaving an empty array instead of the intended values.
    expect(cfg.hints.backoff_thresholds).toEqual([1, 3, 10])
  })

  it('still coerces a comma-separated number list after the field was previously emptied to []', () => {
    cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '[]' })
    invalidateConfigCache()
    cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '1,3,10' })
    invalidateConfigCache()
    const cfg = loadConfig()
    // Pre-fix, coerce() decided "is this a number list?" purely from existing.length > 0.
    // Once the field was emptied to [], that check saw length 0 and treated the field as a
    // plain string list, so the comma-split segments stayed strings and the load-time
    // int-list validator silently filtered them all out to [] again.
    expect(cfg.hints.backoff_thresholds).toEqual([1, 3, 10])
  })

  it('rejects setting an entire config section to a scalar value instead of corrupting it (#M24)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist', value: 'oops' })).toThrow()
    expect(capturedErr()).toContain('section')
    invalidateConfigCache()
    const cfg = loadConfig()
    // The section must still be a valid object with its documented fields intact, not
    // silently replaced with the raw string (which would serialize every field as undefined).
    expect(typeof cfg.compact_assist).toBe('object')
    expect(cfg.compact_assist.min_events).toBe(3)
  })

  it('rejects a config set value above the documented max instead of silently clamping on disk (#M28)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '2000' })).toThrow()
    expect(capturedErr()).toContain('outside the allowed range')
    // The out-of-range value must never reach disk in the first place.
    expect(fs.existsSync(_testConfigPath)).toBe(false)
  })
})

// ── config set warns when an active env var shadows the just-written value ──

describe('cmdConfig set warns when an active env var shadows the write', () => {
  function withEnv(key: string, value: string | undefined, fn: () => void): void {
    const orig = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    invalidateConfigCache()
    try {
      fn()
    } finally {
      if (orig === undefined) delete process.env[key]
      else process.env[key] = orig
      invalidateConfigCache()
    }
  }

  it('emits a stderr warning naming the env var when it forces a different value than what was just written', () => {
    withEnv('TOKEN_GOAT_BASH_COMPRESS', '0', () => {
      cmdConfig({ action: 'set', key: 'bash_compress.enabled', value: 'true' })
      expect(capturedErr()).toContain('warning')
      expect(capturedErr()).toContain('TOKEN_GOAT_BASH_COMPRESS')
      expect(capturedErr()).toContain('bash_compress.enabled')
    })
    // The write to disk must still have gone through despite the active env var —
    // only the runtime effect is shadowed, not the persisted value.
    withEnv('TOKEN_GOAT_BASH_COMPRESS', undefined, () => {
      expect(loadConfig().bash_compress.enabled).toBe(true)
    })
  })

  it('does not warn when the key being set has no env-var override at all', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '55' })
    expect(capturedErr()).toBe('')
  })

  it('does not warn when an env var is active but its value matches what was just written', () => {
    withEnv('TOKEN_GOAT_BASH_COMPRESS', '1', () => {
      cmdConfig({ action: 'set', key: 'bash_compress.enabled', value: 'true' })
      expect(capturedErr()).toBe('')
    })
  })
})

// ── mutate-then-save commands must not bake env overrides into disk (#M21) ───

describe('config set / project exclude / prune do not persist transient env overrides (#M21)', () => {
  function withBashCompressEnvOff(fn: () => void): void {
    const prevEnv = process.env['TOKEN_GOAT_BASH_COMPRESS']
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    invalidateConfigCache()
    try {
      fn()
    } finally {
      if (prevEnv === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
      else process.env['TOKEN_GOAT_BASH_COMPRESS'] = prevEnv
      invalidateConfigCache()
    }
  }

  it('config set does not bake a TOKEN_GOAT_BASH_COMPRESS override into bash_compress.enabled on disk', () => {
    withBashCompressEnvOff(() => {
      cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '50' })
    })
    // The env override is gone again now, so loadConfig() reflects disk only.
    expect(loadConfig().bash_compress.enabled).toBe(true)
  })

  it('project exclude does not bake a TOKEN_GOAT_BASH_COMPRESS override into bash_compress.enabled on disk', () => {
    withBashCompressEnvOff(() => {
      cmdProject({ action: 'exclude', pathArg: '/tmp/env-test-proj' })
    })
    expect(loadConfig().bash_compress.enabled).toBe(true)
  })

  it('project prune does not bake a TOKEN_GOAT_BASH_COMPRESS override into bash_compress.enabled on disk', () => {
    withBashCompressEnvOff(() => {
      cmdProject({ action: 'prune' })
    })
    expect(loadConfig().bash_compress.enabled).toBe(true)
  })
})

// ── config validate ──────────────────────────────────────────────────────────

describe('cmdConfig validate', () => {
  it('reports no issues for an absent config (defaults only)', () => {
    cmdConfig({ action: 'validate' })
    expect(captured()).toContain('no issues found')
  })

  it('detects an unknown top-level section', () => {
    fs.writeFileSync(_testConfigPath, '[unknown_xyz]\nfoo = true\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate' })
    const out = captured()
    expect(out).toContain('unknown_section')
    expect(out).toContain('unknown_xyz')
  })

  it('detects an unknown key within a known section', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nno_such_key_xyz = true\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate' })
    const out = captured()
    expect(out).toContain('unknown_key')
    expect(out).toContain('no_such_key_xyz')
  })

  it('suggests a close match for an unknown section', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assit]\nenabled = true\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate' })
    expect(captured()).toContain('compact_assist')
  })

  it('--json returns findings array', () => {
    fs.writeFileSync(_testConfigPath, '[bogus_section]\nfoo = 1\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate', json: true })
    const parsed = JSON.parse(captured()) as { findings: unknown[]; ok: boolean }
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(parsed.ok).toBe(false)
  })
})

// ── config unknown action ────────────────────────────────────────────────────

describe('cmdConfig unknown action', () => {
  it('throws on an unknown action', () => {
    expect(() => cmdConfig({ action: 'bogus_action' })).toThrow()
    expect(capturedErr()).toContain('unknown action')
  })
})

// ── project list ─────────────────────────────────────────────────────────────

describe('cmdProject list', () => {
  it('lists blocked roots from config', () => {
    const cfg = loadConfig()
    cfg.worker.blocked_roots = ['/some/excluded/path']
    saveConfig(cfg)
    invalidateConfigCache()
    cmdProject({ action: 'list' })
    const out = captured()
    expect(out).toContain('/some/excluded/path')
  })

  it('--json includes blocked_roots array', () => {
    cmdProject({ action: 'list', json: true })
    const parsed = JSON.parse(captured()) as { blocked_roots: string[] }
    expect(Array.isArray(parsed.blocked_roots)).toBe(true)
  })
})

// ── project exclude ───────────────────────────────────────────────────────────

describe('cmdProject exclude', () => {
  it('appends the path to blocked_roots', () => {
    cmdProject({ action: 'exclude', pathArg: '/tmp/fake-proj' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.worker.blocked_roots.some((r) => r.includes('fake-proj'))).toBe(true)
  })

  it('is idempotent — does not duplicate', () => {
    cmdProject({ action: 'exclude', pathArg: '/tmp/fake-proj' })
    invalidateConfigCache()
    cmdProject({ action: 'exclude', pathArg: '/tmp/fake-proj' })
    invalidateConfigCache()
    const cfg = loadConfig()
    const count = cfg.worker.blocked_roots.filter((r) => r.includes('fake-proj')).length
    expect(count).toBe(1)
  })

  it('throws when path is missing', () => {
    expect(() => cmdProject({ action: 'exclude' })).toThrow()
  })
})

// ── project prune ─────────────────────────────────────────────────────────────

describe('cmdProject prune', () => {
  it('removes non-existent roots and keeps existing ones', () => {
    const real = tmpHome
    const fake = '/this/does/not/exist/ever'
    const cfg = loadConfig()
    cfg.worker.blocked_roots = [real, fake]
    saveConfig(cfg)
    invalidateConfigCache()
    cmdProject({ action: 'prune' })
    invalidateConfigCache()
    const after = loadConfig()
    expect(after.worker.blocked_roots).toContain(real)
    expect(after.worker.blocked_roots).not.toContain(fake)
  })

  it('--json includes pruned count', () => {
    cmdProject({ action: 'prune', json: true })
    const parsed = JSON.parse(captured()) as { pruned: number; blocked_roots: string[] }
    expect(typeof parsed.pruned).toBe('number')
    expect(Array.isArray(parsed.blocked_roots)).toBe(true)
  })
})

// ── compact-doc ──────────────────────────────────────────────────────────────

describe('cmdCompactDoc', () => {
  it('emits a compact for a markdown file with a COMPACT_END marker', () => {
    const md = path.join(tmpHome, 'test.md')
    fs.writeFileSync(md, '# Title\n\n<!-- COMPACT_END -->\n\n## Section\n\nAnother paragraph here. More text here.\n', 'utf8')
    cmdCompactDoc({ filePath: md })
    expect(captured().length).toBeGreaterThan(0)
  })

  it('throws when file does not exist', () => {
    expect(() => cmdCompactDoc({ filePath: '/no/such/file.md' })).toThrow()
    expect(capturedErr()).toContain('compact-doc')
  })

  it('--heading filters to a specific section', () => {
    const md = path.join(tmpHome, 'multi.md')
    fs.writeFileSync(md, '# Title\n\nIntro text.\n\n## Install\n\nRun npm install to set up.\n\n## Usage\n\nRun it to use.\n', 'utf8')
    cmdCompactDoc({ filePath: md, heading: 'Install' })
    const out = captured()
    expect(out.toLowerCase()).toContain('install')
    expect(out.toLowerCase()).not.toContain('usage')
  })

  it('--json wraps the compact', () => {
    const md = path.join(tmpHome, 'j.md')
    fs.writeFileSync(md, '# Doc\n\nIntro text.\n\n<!-- COMPACT_END -->\n\nBody text here.\n', 'utf8')
    cmdCompactDoc({ filePath: md, json: true })
    const parsed = JSON.parse(captured()) as { path: string; compact: string }
    expect(typeof parsed.compact).toBe('string')
    expect(parsed.compact.length).toBeGreaterThan(0)
  })
})

// ── compact-doc: extractive sidecar pipeline (--force/--sentences/--show) ─────

describe('cmdCompactDoc extractive sidecar pipeline', () => {
  function writeDoc(name: string): string {
    const md = path.join(tmpHome, name)
    fs.writeFileSync(
      md,
      '# Title\nLine 1\nLine 2\nLine 3\nLine 4\n\n## Section 2\nOther 1\nOther 2\nOther 3\n',
      'utf8',
    )
    return md
  }

  it('builds a sidecar on disk and prints a short confirmation (no full body) by default', () => {
    const md = writeDoc('default.md')
    const compactPath = compactPathFor(md)

    cmdCompactDoc({ filePath: md })

    expect(fs.existsSync(compactPath)).toBe(true)
    expect(isCompactFresh(compactPath, md)).toBe(true)
    const out = captured()
    expect(out).toContain(compactPath)
    expect(out).not.toContain('Line 3')
  })

  it('--show prints the built sidecar content to stdout', () => {
    const md = writeDoc('show.md')
    cmdCompactDoc({ filePath: md, show: true })

    const out = captured()
    expect(out).toContain('# Title')
    expect(out).toContain('## Section 2')
  })

  it('--sentences controls how many lines per section are kept', () => {
    const md1 = writeDoc('sentences1.md')
    cmdCompactDoc({ filePath: md1, show: true, sentences: '1' })
    const out1 = captured()

    stdoutLines.length = 0
    const md2 = writeDoc('sentences4.md')
    cmdCompactDoc({ filePath: md2, show: true, sentences: '4' })
    const out2 = captured()

    expect(out1).toContain('Line 1')
    expect(out1).not.toContain('Line 2')
    expect(out2).toContain('Line 1')
    expect(out2).toContain('Line 4')
  })

  it('rejects a non-positive --sentences value', () => {
    const md = writeDoc('bad-sentences.md')
    expect(() => cmdCompactDoc({ filePath: md, sentences: '0' })).toThrow()
    expect(capturedErr()).toContain('--sentences')
  })

  it('rejects a non-numeric --sentences value', () => {
    const md = writeDoc('nan-sentences.md')
    expect(() => cmdCompactDoc({ filePath: md, sentences: 'abc' })).toThrow()
    expect(capturedErr()).toContain('--sentences')
  })

  it('reuses a fresh sidecar without --force (rebuilt: false)', () => {
    const md = writeDoc('reuse.md')
    cmdCompactDoc({ filePath: md, json: true })
    const first = JSON.parse(captured()) as { rebuilt: boolean; compact: string }
    expect(first.rebuilt).toBe(true)

    stdoutLines.length = 0
    cmdCompactDoc({ filePath: md, json: true })
    const second = JSON.parse(captured()) as { rebuilt: boolean; compact: string }
    expect(second.rebuilt).toBe(false)
    expect(second.compact).toBe(first.compact)
  })

  it('--force rebuilds even when a fresh sidecar already exists', () => {
    const md = writeDoc('force.md')
    cmdCompactDoc({ filePath: md, json: true })
    const first = JSON.parse(captured()) as { rebuilt: boolean }
    expect(first.rebuilt).toBe(true)

    stdoutLines.length = 0
    cmdCompactDoc({ filePath: md, json: true, force: true })
    const second = JSON.parse(captured()) as { rebuilt: boolean }
    expect(second.rebuilt).toBe(true)
  })

  it('--json includes path, compactPath, rebuilt, and compact fields', () => {
    const md = writeDoc('json-shape.md')
    cmdCompactDoc({ filePath: md, json: true })
    const parsed = JSON.parse(captured()) as {
      path: string
      compactPath: string
      rebuilt: boolean
      compact: string
    }
    expect(parsed.path).toBe(path.resolve(md))
    expect(parsed.compactPath).toBe(compactPathFor(md))
    expect(parsed.rebuilt).toBe(true)
    expect(parsed.compact.length).toBeGreaterThan(0)
  })
})

// ── fetch-image (fetchBuffer redirect cap) ────────────────────────────────────

describe('cmdFetchImage security hardening (regression: fetchBuffer now routes through webfetch.ts\'s SSRF/size/redirect-capped performHttpFetch instead of a bare, unguarded http.get)', () => {
  it('rejects a loopback/private-IP URL with a clear SSRF error, using the real (unmocked) SSRF check', async () => {
    const out = path.join(tmpHome, 'ssrf-blocked.bin')
    await expect(cmdFetchImage({ url: 'http://127.0.0.1:1/image.png', out })).rejects.toThrow()
    expect(capturedErr()).toMatch(/blocked by ssrf safety check/i)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('still fetches a normal public URL (network mocked) and writes the returned bytes to disk', async () => {
    const fakeBytes = Buffer.from('fake-image-bytes')
    performHttpFetchMock.mockImplementationOnce(
      async (url: string, opts: { maxSizeBytes: number; timeoutSec: number; redirectsLeft: number }) => {
        expect(url).toBe('http://example.test/image.png')
        expect(opts.maxSizeBytes).toBeGreaterThan(0)
        expect(opts.timeoutSec).toBeGreaterThan(0)
        expect(opts.redirectsLeft).toBe(5)
        return { status: 200, statusText: 'OK', headers: {}, body: fakeBytes }
      },
    )
    const out = path.join(tmpHome, 'happy-path.bin')
    await cmdFetchImage({ url: 'http://example.test/image.png', out })
    expect(fs.readFileSync(out)).toEqual(fakeBytes)
  })

  it('rejects with the HTTP status when performHttpFetch resolves a non-2xx response', async () => {
    performHttpFetchMock.mockImplementationOnce(async () => ({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: Buffer.alloc(0),
    }))
    const out = path.join(tmpHome, 'not-found.bin')
    await expect(cmdFetchImage({ url: 'http://example.test/missing.png', out })).rejects.toThrow()
    expect(capturedErr()).toMatch(/HTTP 404/)
  })

  it('propagates a too-many-redirects rejection from performHttpFetch instead of swallowing it', async () => {
    performHttpFetchMock.mockImplementationOnce(async () => {
      throw new Error('Too many redirects fetching http://redirect-loop.example.test/start')
    })
    const out = path.join(tmpHome, 'redirect-loop.bin')
    await expect(cmdFetchImage({ url: 'http://redirect-loop.example.test/start', out })).rejects.toThrow()
    expect(capturedErr()).toMatch(/too many redirects/i)
  })
})

// ── history ───────────────────────────────────────────────────────────────────

describe('cmdHistory', () => {
  it('reports empty when no blobs exist', () => {
    cmdHistory({})
    expect(captured()).toContain('No history entries found')
  })

  it('shows bash entries when bash blobs are present', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'abc123', { command: 'npm run build', storedAt: Date.now(), exitCode: 0, sizeBytes: 100 })
    cmdHistory({})
    expect(captured()).toContain('npm run build')
  })

  it('shows web entries when web blobs are present', () => {
    storeBlob(WEB_OUTPUT_SUBDIR, 'web001', { url: 'https://example.com/api', content: 'body text' })
    cmdHistory({})
    expect(captured()).toContain('https://example.com/api')
  })

  it('--limit restricts output count', () => {
    for (let i = 0; i < 5; i++) {
      storeBlob(BASH_OUTPUT_SUBDIR, `cmd${i}`, { command: `echo ${i}`, storedAt: Date.now() + i, exitCode: 0, sizeBytes: 10 })
    }
    cmdHistory({ limit: '2' })
    const lines = captured().split('\n').filter((l) => l.includes('bash'))
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('rejects a non-numeric --limit instead of silently returning empty output', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'abc123', { command: 'npm run build', storedAt: Date.now(), exitCode: 0, sizeBytes: 100 })
    // Pre-fix, Number.parseInt('abc', 10) produced NaN, Math.max(1, NaN) stayed NaN, and
    // Array.prototype.slice(0, NaN) returns [] — so an invalid --limit silently printed "No
    // history entries found" even though entries existed, instead of raising a clear error.
    expect(() => cmdHistory({ limit: 'abc' })).toThrow()
    expect(capturedErr()).toContain('--limit')
  })

  it('--json emits an array', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'xyz', { command: 'ls', storedAt: Date.now(), exitCode: 0, sizeBytes: 10 })
    cmdHistory({ json: true })
    const arr = JSON.parse(captured()) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr.length).toBeGreaterThan(0)
  })
})
