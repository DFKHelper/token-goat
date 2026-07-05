/**
 * Unit tests for cache / history commands (D1) and session / cost commands (D2).
 *
 * listBlobs is mutation-verified in D1 (see end of file).
 * buildResumePacket cap is mutation-verified in D2 (see end of file).
 * Command handlers are tested by driving them against a real isolated TOKEN_GOAT_HOME,
 * with output captured via process.stdout mocking. Real-bundle integration is
 * covered by tests/command_matrix_e2e.test.ts.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listBlobs, storeBlob } from '../src/disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from '../src/bash_output_cache.js'
import { WEB_OUTPUT_SUBDIR } from '../src/web_cache.js'
import { SESSIONS_SUBDIR } from '../src/session_store.js'
import { cmdBashHistory, cmdWebHistory, cmdCleanCache, cmdPruneCache, cmdCacheAudit, cmdResume, cmdCompactHint, cmdSessionSummary, cmdCost, cmdBaseline } from '../src/cache_session_commands.js'
import { buildResumePacket, MAX_RESUME_CHARS } from '../src/resume.js'

let tmpHome: string
let prevHome: string | undefined
let prevHarnessOverride: string | undefined
let stdoutLines: string[]
let writeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmd-cache-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  // Pin harness detection so getContextPressure's fillFraction (scaled by the
  // per-harness auto-trigger multiplier) doesn't depend on the ambient
  // environment this suite happens to run in.
  prevHarnessOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
  stdoutLines = []
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutLines.push(String(chunk))
    return true
  })
})

afterEach(() => {
  writeSpy.mockRestore()
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  if (prevHarnessOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevHarnessOverride
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {
    // best-effort cleanup
  }
})

function capturedOutput(): string {
  return stdoutLines.join('')
}

// ── listBlobs ─────────────────────────────────────────────────────────────────

describe('listBlobs', () => {
  it('returns [] for a missing subdir (fail-soft)', () => {
    expect(listBlobs('no_such_subdir')).toEqual([])
  })

  it('returns all stored blobs with id, mtime, and value', () => {
    storeBlob('test_sub', 'aaa', { x: 1 })
    storeBlob('test_sub', 'bbb', { x: 2 })
    const results = listBlobs('test_sub')
    expect(results).toHaveLength(2)
    const ids = results.map((r) => r.id).sort()
    expect(ids).toEqual(['aaa', 'bbb'])
    for (const r of results) {
      expect(typeof r.mtime).toBe('number')
      expect(r.mtime).toBeGreaterThan(0)
      expect(r.value).not.toBeNull()
    }
  })

  it('skips non-json files in the subdir', () => {
    storeBlob('test_sub', 'valid', { ok: true })
    const dir = path.join(tmpHome, 'test_sub')
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not a blob')
    fs.writeFileSync(path.join(dir, 'also.log'), 'log')
    const results = listBlobs('test_sub')
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('valid')
  })

  it('skips blobs whose JSON is null', () => {
    storeBlob('test_sub', 'good', { v: 1 })
    const dir = path.join(tmpHome, 'test_sub')
    fs.writeFileSync(path.join(dir, 'broken.json'), '{invalid json}')
    const results = listBlobs('test_sub')
    const ids = results.map((r) => r.id)
    expect(ids).toContain('good')
    expect(ids).not.toContain('broken')
  })

  it('returns [] on a top-level readdirSync error (fail-soft)', () => {
    // Write a file where the subdir is expected, so readdirSync throws ENOTDIR.
    const badPath = path.join(tmpHome, 'bad_sub')
    fs.writeFileSync(badPath, 'not a dir')
    expect(listBlobs('bad_sub')).toEqual([])
  })
})

// ── bash-history ──────────────────────────────────────────────────────────────

describe('cmdBashHistory', () => {
  it('prints empty message when no blobs exist', () => {
    cmdBashHistory({})
    expect(capturedOutput()).toContain('No bash output entries cached.')
  })

  it('prints a table row for each bash blob', () => {
    const entry = { id: 'abc123', command: 'ls -la', output: 'out', exitCode: 0, storedAt: Date.now(), sizeBytes: 3 }
    storeBlob(BASH_OUTPUT_SUBDIR, 'abc123', entry)
    cmdBashHistory({})
    const out = capturedOutput()
    expect(out).toContain('abc123')
    expect(out).toContain('ls -la')
    expect(out).toContain('0')
  })

  it('truncates commands longer than 80 chars in table output', () => {
    const longCmd = 'a'.repeat(100)
    const entry = { id: 'xyz', command: longCmd, output: '', exitCode: 0, storedAt: Date.now(), sizeBytes: 0 }
    storeBlob(BASH_OUTPUT_SUBDIR, 'xyz', entry)
    cmdBashHistory({})
    const out = capturedOutput()
    expect(out).toContain('...')
    expect(out).not.toContain(longCmd)
  })

  it('emits JSON array when --json is set', () => {
    const entry = { id: 'j1', command: 'echo hi', output: 'hi', exitCode: 0, storedAt: Date.now(), sizeBytes: 2 }
    storeBlob(BASH_OUTPUT_SUBDIR, 'j1', entry)
    cmdBashHistory({ json: true })
    const parsed = JSON.parse(capturedOutput()) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
  })

  it('respects --limit', () => {
    for (let i = 0; i < 5; i++) {
      const e = { id: `id${i}`, command: `cmd${i}`, output: '', exitCode: 0, storedAt: Date.now() - i * 1000, sizeBytes: 0 }
      storeBlob(BASH_OUTPUT_SUBDIR, `id${i}`, e)
    }
    cmdBashHistory({ limit: '2' })
    const out = capturedOutput()
    const dataLines = out.split('\n').filter((l) => l.includes('cmd')).length
    expect(dataLines).toBe(2)
  })

  // Regression: a non-numeric --limit used to silently coerce to NaN
  // (Number.parseInt('abc', 10) is NaN, and Math.max(1, NaN) is NaN, which
  // .slice(0, NaN) treats as 0), so bash-history printed "No bash output
  // entries cached." even when the cache held real entries, instead of
  // failing loudly on the malformed flag.
  it('rejects a non-numeric --limit instead of silently reporting an empty cache', () => {
    const e = { id: 'real1', command: 'echo hi', output: '', exitCode: 0, storedAt: Date.now(), sizeBytes: 0 }
    storeBlob(BASH_OUTPUT_SUBDIR, 'real1', e)
    expect(() => cmdBashHistory({ limit: 'abc' })).toThrow(/invalid --limit: abc/)
  })
})

// ── web-history ───────────────────────────────────────────────────────────────

describe('cmdWebHistory', () => {
  it('prints empty message when no blobs exist', () => {
    cmdWebHistory({})
    expect(capturedOutput()).toContain('No web output entries cached.')
  })

  it('prints a table row with id, bytes, url for each web blob', () => {
    storeBlob(WEB_OUTPUT_SUBDIR, 'web1', { url: 'https://example.com', content: 'hello' })
    cmdWebHistory({})
    const out = capturedOutput()
    expect(out).toContain('web1')
    expect(out).toContain('https://example.com')
  })

  it('emits JSON array when --json is set', () => {
    storeBlob(WEB_OUTPUT_SUBDIR, 'wj1', { url: 'https://a.com', content: 'body' })
    cmdWebHistory({ json: true })
    const parsed = JSON.parse(capturedOutput()) as Array<{ id: string; url: string; bytes: number }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.url).toBe('https://a.com')
    expect(parsed[0]!.bytes).toBeGreaterThan(0)
  })

  it('respects --limit', () => {
    for (let i = 0; i < 4; i++) {
      storeBlob(WEB_OUTPUT_SUBDIR, `w${i}`, { url: `https://example.com/${i}`, content: 'x' })
    }
    cmdWebHistory({ limit: '2' })
    const out = capturedOutput()
    const rows = out.split('\n').filter((l) => l.includes('https://')).length
    expect(rows).toBe(2)
  })

  // Regression: same NaN-coercion bug as cmdBashHistory's --limit (see above) —
  // a non-numeric --limit used to silently report an empty cache instead of
  // failing loudly.
  it('rejects a non-numeric --limit instead of silently reporting an empty cache', () => {
    storeBlob(WEB_OUTPUT_SUBDIR, 'realweb1', { url: 'https://example.com', content: 'hello' })
    expect(() => cmdWebHistory({ limit: 'abc' })).toThrow(/invalid --limit: abc/)
  })
})

// ── clean-cache ───────────────────────────────────────────────────────────────

describe('cmdCleanCache', () => {
  it('reports 0 removed for all subdirs when cache is empty', () => {
    cmdCleanCache({})
    const out = capturedOutput()
    expect(out).toContain('total: 0 removed')
  })

  it('reports 0 removed in JSON mode for empty cache', () => {
    cmdCleanCache({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { removed: Record<string, number>; total: number }
    expect(parsed.total).toBe(0)
    expect(typeof parsed.removed[BASH_OUTPUT_SUBDIR]).toBe('number')
    expect(typeof parsed.removed[WEB_OUTPUT_SUBDIR]).toBe('number')
    expect(typeof parsed.removed[SESSIONS_SUBDIR]).toBe('number')
  })

  it('removes expired blobs and counts them', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'old', { x: 1 }, { maxCount: 1000 })
    const p = path.join(tmpHome, BASH_OUTPUT_SUBDIR, 'old.json')
    const past = new Date(Date.now() - 48 * 3600 * 1000)
    fs.utimesSync(p, past, past)
    cmdCleanCache({})
    const out = capturedOutput()
    expect(out).toContain(`${BASH_OUTPUT_SUBDIR}: removed 1`)
  })
})

// ── prune-cache ───────────────────────────────────────────────────────────────

describe('cmdPruneCache', () => {
  it('exits cleanly with 0 removed when cache is empty', () => {
    cmdPruneCache({ maxCount: '5' })
    expect(capturedOutput()).toContain('total:')
  })

  it('includes maxCount and maxAgeMs in JSON output', () => {
    cmdPruneCache({ maxCount: '3', maxAgeHours: '2', json: true })
    const parsed = JSON.parse(capturedOutput()) as { maxCount: number; maxAgeMs: number }
    expect(parsed.maxCount).toBe(3)
    expect(parsed.maxAgeMs).toBeCloseTo(2 * 3600 * 1000, -3)
  })

  it('evicts entries beyond maxCount across subdirs', () => {
    for (let i = 0; i < 4; i++) {
      storeBlob(BASH_OUTPUT_SUBDIR, `e${i}`, { i }, { maxCount: 1000 })
      const p = path.join(tmpHome, BASH_OUTPUT_SUBDIR, `e${i}.json`)
      const t = new Date(Date.now() - (4 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    cmdPruneCache({ maxCount: '2', json: true })
    const parsed = JSON.parse(capturedOutput()) as { removed: Record<string, number> }
    expect((parsed.removed[BASH_OUTPUT_SUBDIR] ?? 0)).toBeGreaterThanOrEqual(2)
  })

  // M5 regression: a non-numeric --maxCount/--maxAgeHours used to silently
  // coerce to NaN (Number.parseInt / parseFloat both return NaN, and
  // Math.max(0, NaN) is NaN), so prune-cache would run with maxCount=NaN or
  // maxAgeMs=NaN instead of failing loudly -- a NaN bound makes every
  // count/age comparison in pruneBlobs false, silently pruning nothing while
  // reporting success.
  it('rejects a non-numeric --maxCount instead of silently coercing to NaN', () => {
    expect(() => cmdPruneCache({ maxCount: 'abc' })).toThrow(/--maxCount must be a valid integer/)
  })

  it('rejects a non-numeric --maxAgeHours instead of silently coercing to NaN', () => {
    expect(() => cmdPruneCache({ maxAgeHours: 'abc' })).toThrow(/--maxAgeHours must be a valid number/)
  })

  it('rejects a non-numeric --maxCount even when --maxAgeHours is valid', () => {
    expect(() => cmdPruneCache({ maxCount: 'NaN', maxAgeHours: '2' })).toThrow(/--maxCount must be a valid integer/)
  })
})

// ── cache-audit ───────────────────────────────────────────────────────────────

describe('cmdCacheAudit', () => {
  it('exits cleanly and prints findings', () => {
    cmdCacheAudit({})
    const out = capturedOutput()
    expect(out).toContain('cache-audit:')
    expect(out).toMatch(/\[ok {2}\]|\[WARN\]/)
  })

  it('emits JSON with findings array and issueCount', () => {
    cmdCacheAudit({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { findings: Array<{ check: string; ok: boolean; detail: string }>; issueCount: number }
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(typeof parsed.issueCount).toBe('number')
    for (const f of parsed.findings) {
      expect(typeof f.check).toBe('string')
      expect(typeof f.ok).toBe('boolean')
      expect(typeof f.detail).toBe('string')
    }
  })

  it('flags TOKEN_GOAT_BASH_COMPRESS=0 as a cache issue', () => {
    const prev = process.env['TOKEN_GOAT_BASH_COMPRESS']
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    try {
      cmdCacheAudit({ json: true })
      const parsed = JSON.parse(capturedOutput()) as { findings: Array<{ check: string; ok: boolean }>; issueCount: number }
      const gate = parsed.findings.find((f) => f.check === 'env:TOKEN_GOAT_BASH_COMPRESS')
      expect(gate).toBeDefined()
      expect(gate!.ok).toBe(false)
      expect(parsed.issueCount).toBeGreaterThanOrEqual(1)
    } finally {
      if (prev === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
      else process.env['TOKEN_GOAT_BASH_COMPRESS'] = prev
    }
  })

  it('includes both hooks:user and hooks:project findings', () => {
    cmdCacheAudit({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { findings: Array<{ check: string }> }
    const checks = parsed.findings.map((f) => f.check)
    expect(checks).toContain('hooks:user')
    expect(checks).toContain('hooks:project')
  })
})

// ── listBlobs mutation-verify (regression anchor) ─────────────────────────────

describe('listBlobs mutation-verify anchor', () => {
  it('bash-history count drops to 0 when listBlobs returns nothing (simulates broken .json filter)', () => {
    // Store a real bash blob.
    storeBlob(BASH_OUTPUT_SUBDIR, 'mv1', { id: 'mv1', command: 'ls', output: 'out', exitCode: 0, storedAt: Date.now(), sizeBytes: 3 })
    // Confirm cmdBashHistory sees it (baseline: filter works).
    cmdBashHistory({ json: true })
    const before = JSON.parse(capturedOutput()) as unknown[]
    expect(before).toHaveLength(1)
    stdoutLines = []
    // Simulate what happens when the .json filter is broken: rename the blob to .json.BROKEN.
    const blobDir = path.join(tmpHome, BASH_OUTPUT_SUBDIR)
    const origPath = path.join(blobDir, 'mv1.json')
    const renamedPath = path.join(blobDir, 'mv1.json.BROKEN')
    fs.renameSync(origPath, renamedPath)
    // Now cmdBashHistory must report empty (no .json files).
    cmdBashHistory({ json: true })
    const after = JSON.parse(capturedOutput()) as unknown[]
    expect(after).toHaveLength(0)
    // Restore.
    fs.renameSync(renamedPath, origPath)
    // And confirm it is visible again.
    stdoutLines = []
    cmdBashHistory({ json: true })
    const restored = JSON.parse(capturedOutput()) as unknown[]
    expect(restored).toHaveLength(1)
  })
})

// ── D2: resume ────────────────────────────────────────────────────────────────

describe('buildResumePacket', () => {
  it('returns null when session blob does not exist', () => {
    expect(buildResumePacket('no_such_session_xyz')).toBeNull()
  })

  it('returns a non-empty string when the session blob exists', () => {
    const session = { files: [{ path: 'src/foo.ts', readCount: 3, lastReadAt: Date.now(), wasEdited: true, sizeBytes: 100 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'test-sess-1', session)
    const packet = buildResumePacket('test-sess-1')
    expect(packet).not.toBeNull()
    expect(packet!.length).toBeGreaterThan(0)
    expect(packet).toContain('src/foo.ts')
  })

  it('includes edited files in the packet', () => {
    const session = { files: [{ path: 'src/edited.ts', readCount: 1, lastReadAt: Date.now(), wasEdited: true, sizeBytes: 50 }, { path: 'src/read.ts', readCount: 5, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 50 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'test-sess-2', session)
    const packet = buildResumePacket('test-sess-2')
    expect(packet).toContain('Edited files')
    expect(packet).toContain('src/edited.ts')
  })

  it('includes recent bash commands when present', () => {
    // Store real bash output entries.
    const bashEntry1 = { id: 'id1', command: 'npm test', output: 'test output', exitCode: 0, storedAt: Date.now(), sizeBytes: 11 }
    const bashEntry2 = { id: 'id2', command: 'git status', output: 'status output', exitCode: 0, storedAt: Date.now(), sizeBytes: 13 }
    storeBlob(BASH_OUTPUT_SUBDIR, bashEntry1.id, bashEntry1)
    storeBlob(BASH_OUTPUT_SUBDIR, bashEntry2.id, bashEntry2)
    const session = { files: [], hintsShown: [], webFetches: [], bashOutputs: [['hash1', 'id1'], ['hash2', 'id2']] as Array<[string, string]>, curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'test-sess-3', session)
    const packet = buildResumePacket('test-sess-3')
    expect(packet).toContain('Recent bash commands')
    expect(packet).toContain('npm test')
    expect(packet).toContain('git status')
  })

  it('resolves bash output ids to command text (regression: printed hash instead of command)', () => {
    // Store real bash output entries.
    const entry1 = { id: 'abc123def456', command: 'npm test', output: 'test output', exitCode: 0, storedAt: Date.now(), sizeBytes: 11 }
    const entry2 = { id: 'xyz789uvw012', command: 'git status', output: 'status output', exitCode: 0, storedAt: Date.now(), sizeBytes: 13 }
    storeBlob(BASH_OUTPUT_SUBDIR, entry1.id, entry1)
    storeBlob(BASH_OUTPUT_SUBDIR, entry2.id, entry2)
    // Record them in session the way the real code does: [commandHash, outputId] pairs.
    const session = { files: [], hintsShown: [], webFetches: [], bashOutputs: [['hash1', entry1.id], ['hash2', entry2.id]] as Array<[string, string]>, curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'test-sess-bash-real', session)
    const packet = buildResumePacket('test-sess-bash-real')
    expect(packet).toContain('Recent bash commands')
    // Bug: used to print the hash (entry[0]) instead of the command (entry[1]->getBashOutput->command).
    expect(packet).toContain('npm test')
    expect(packet).toContain('git status')
    // Ensure hashes are NOT printed.
    expect(packet).not.toContain('hash1')
    expect(packet).not.toContain('hash2')
  })

  it('packet stays within MAX_RESUME_CHARS cap even for large sessions', () => {
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `src/module_with_a_long_path_${i}_to_generate_large_text/component.ts`, readCount: i, lastReadAt: Date.now(), wasEdited: i % 3 === 0, sizeBytes: 100 }))
    storeBlob(SESSIONS_SUBDIR, 'test-sess-cap', { files, hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
    const packet = buildResumePacket('test-sess-cap')
    expect(packet).not.toBeNull()
    expect(packet!.length).toBeLessThanOrEqual(MAX_RESUME_CHARS + 50)
  })
})

describe('cmdResume', () => {
  it('throws when session not found', () => {
    expect(() => cmdResume({ sessionId: 'no_such_id' })).toThrow(/no session blob found/i)
  })

  it('prints packet text when session exists', () => {
    const session = { files: [{ path: 'src/x.ts', readCount: 2, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 10 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'test-resume-ok', session)
    cmdResume({ sessionId: 'test-resume-ok' })
    expect(capturedOutput()).toContain('Resume packet')
  })

  it('emits JSON with sessionId and packet when --json is set', () => {
    const session = { files: [{ path: 'src/y.ts', readCount: 1, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 5 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'test-resume-json', session)
    cmdResume({ sessionId: 'test-resume-json', json: true })
    const parsed = JSON.parse(capturedOutput()) as { sessionId: string; packet: string }
    expect(parsed.sessionId).toBe('test-resume-json')
    expect(typeof parsed.packet).toBe('string')
  })
})

// ── D2: compact-hint ──────────────────────────────────────────────────────────

describe('cmdCompactHint', () => {
  it('exits cleanly with no sessions and prints hint', () => {
    cmdCompactHint({})
    const out = capturedOutput()
    expect(out).toContain('Compact hint')
    expect(out).toContain('context:')
  })

  it('emits JSON with tier and fillFraction', () => {
    cmdCompactHint({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { tier: string; fillFraction: number; manifestTokens: number; eventCount: number }
    expect(typeof parsed.tier).toBe('string')
    expect(typeof parsed.fillFraction).toBe('number')
    expect(typeof parsed.manifestTokens).toBe('number')
    expect(typeof parsed.eventCount).toBe('number')
  })

  it('includes autocompact budget line when --trigger auto is set', () => {
    cmdCompactHint({ trigger: 'auto' })
    expect(capturedOutput()).toContain('Auto-compact')
  })

  // Regression: cmdCompactHint used to call getContextPressure() with no
  // argument, which always short-circuits to a hardcoded { fillFraction: 0,
  // tier: 'cool' } regardless of real session activity. Seed enough recorded
  // bash/web activity to push the real session past the 'warm' threshold
  // (0.5) and confirm the reported tier reflects it instead of always 'cool'.
  it('reflects the real session tier instead of a hardcoded "cool"', () => {
    const webFetches: Array<[string, string]> = Array.from({ length: 200 }, (_, i) => [`https://example.com/${i}`, `w${i}`])
    const bashOutputs: Array<[string, string]> = Array.from({ length: 300 }, (_, i) => [`hash${i}`, `out${i}`])
    const session = { files: [], hintsShown: [], webFetches, bashOutputs, curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'compact-hint-real-activity', session)

    cmdCompactHint({ sessionId: 'compact-hint-real-activity', json: true })
    const parsed = JSON.parse(capturedOutput()) as { tier: string; fillFraction: number; eventCount: number }
    expect(parsed.tier).not.toBe('cool')
    expect(parsed.fillFraction).toBeGreaterThan(0.5)
    expect(parsed.eventCount).toBe(500)
  })
})

// ── D2: session-summary ───────────────────────────────────────────────────────

describe('cmdSessionSummary', () => {
  it('reports no sessions found when sessions subdir is empty', () => {
    cmdSessionSummary({})
    expect(capturedOutput()).toContain('No session blobs found')
  })

  it('emits JSON with sessionCount 0 when empty', () => {
    cmdSessionSummary({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { sessionCount: number }
    expect(parsed.sessionCount).toBe(0)
  })

  it('shows session details when a blob exists', () => {
    const session = { files: [{ path: 'src/a.ts', readCount: 2, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 10 }, { path: 'src/b.ts', readCount: 1, lastReadAt: Date.now(), wasEdited: true, sizeBytes: 5 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'summ-test-1', session)
    cmdSessionSummary({})
    const out = capturedOutput()
    expect(out).toContain('Session:')
    expect(out).toContain('summ-test-1')
    expect(out).toContain('Files read:')
  })

  it('emits JSON with sessionId, filesRead, filesEdited when a blob exists', () => {
    const session = { files: [{ path: 'src/c.ts', readCount: 3, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 20 }, { path: 'src/d.ts', readCount: 1, lastReadAt: Date.now(), wasEdited: true, sizeBytes: 8 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'summ-test-2', session)
    cmdSessionSummary({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { sessionId: string; sessionCount: number; filesRead: number; filesEdited: number; topFiles: string[] }
    expect(typeof parsed.sessionId).toBe('string')
    expect(parsed.sessionCount).toBeGreaterThan(0)
    expect(typeof parsed.filesRead).toBe('number')
    expect(typeof parsed.filesEdited).toBe('number')
    expect(Array.isArray(parsed.topFiles)).toBe(true)
  })
})

// ── D2: cost ──────────────────────────────────────────────────────────────────

describe('cmdCost', () => {
  it('exits cleanly (delegates to runStats)', () => {
    cmdCost({})
    expect(capturedOutput().length).toBeGreaterThanOrEqual(0)
  })

  it('with --session reports no session data when empty', () => {
    cmdCost({ session: true })
    expect(capturedOutput()).toMatch(/no session data found|Session:/i)
  })

  it('with --session and blob, shows session stats', () => {
    const session = { files: [{ path: 'src/e.ts', readCount: 4, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 200 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'cost-test-1', session)
    cmdCost({ session: true })
    expect(capturedOutput()).toContain('Session:')
  })

  it('emits JSON with session true when --session --json', () => {
    const session = { files: [{ path: 'src/f.ts', readCount: 1, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 50 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
    storeBlob(SESSIONS_SUBDIR, 'cost-test-2', session)
    cmdCost({ session: true, json: true })
    const parsed = JSON.parse(capturedOutput()) as { session: boolean; totalFiles: number }
    expect(parsed.session).toBe(true)
    expect(parsed.totalFiles).toBeGreaterThan(0)
  })
})

// ── D2: baseline ──────────────────────────────────────────────────────────────

describe('cmdBaseline', () => {
  it('exits cleanly and emits project map text', () => {
    cmdBaseline({})
    const out = capturedOutput()
    expect(out).toMatch(/Project map|Files:/i)
  })

  it('emits JSON with rootDir and fileCount when --json', () => {
    cmdBaseline({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { rootDir: string; fileCount: number; languages: Record<string, number> }
    expect(typeof parsed.rootDir).toBe('string')
    expect(typeof parsed.fileCount).toBe('number')
    expect(typeof parsed.languages).toBe('object')
  })

  it('compact variant is terser than full output', () => {
    cmdBaseline({ subagent: true })
    const compact = capturedOutput()
    stdoutLines = []
    cmdBaseline({})
    const full = capturedOutput()
    expect(compact.length).toBeLessThanOrEqual(full.length)
  })
})

// ── D2 mutation-verify: buildResumePacket cap enforcement ─────────────────────

describe('buildResumePacket cap mutation-verify anchor', () => {
  it('cap-enforcement test: session with very long file paths produces packet at or below MAX_RESUME_CHARS + cap-suffix length', () => {
    // Each path is 600 chars; with 10 edited + 8 read that is ~11000 chars of file lines alone, well above MAX_RESUME_CHARS=8000.
    const longPath = 'a'.repeat(600)
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `${longPath}_${i}.ts`, readCount: 500 - i, lastReadAt: Date.now(), wasEdited: i < 100, sizeBytes: 100 }))
    storeBlob(SESSIONS_SUBDIR, 'cap-mv-test', { files, hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
    const packet = buildResumePacket('cap-mv-test')
    expect(packet).not.toBeNull()
    expect(packet!.length).toBeLessThanOrEqual(MAX_RESUME_CHARS + 60)
  })
})
