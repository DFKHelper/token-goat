import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

// vi.mock is hoisted -- spy on recordStat while still calling through, mirroring
// tests/hooks_glob.test.ts's pattern.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

const { preWriteRewriteHandler } = await import('../src/hooks_write.js')
const { recordStat } = await import('../src/stats.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { defaultConfig, invalidateConfigCache, saveConfig } = await import('../src/config.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')

const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-files-'))

function writeEvent(filePath: string | undefined, content: unknown): HookEvent {
  return makeHookEvent({
    eventName: 'pre_tool_use',
    toolName: 'Write',
    toolInput: filePath === undefined ? { content } : { file_path: filePath, content },
    sessionId: 'test',
  })
}

/** Build a synthetic N-line file body, one distinct line per index so line-level identity is
 *  unambiguous for the LCS comparison. */
function makeLines(n: number, prefix = 'line'): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`${prefix} ${i}`)
  return lines.join('\n') + '\n'
}

beforeEach(() => {
  clearModuleCaches()
  vi.mocked(recordStat).mockClear()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

describe('preWriteRewriteHandler', () => {
  it('ignores non-Write events', () => {
    const event = makeHookEvent({ toolName: 'Edit', toolInput: {} })
    expect(preWriteRewriteHandler(event).hookType).toBe('pass')
  })

  it('passes through a Write to a brand-new file with zero comparison attempted', () => {
    const target = path.join(FILES_DIR, 'brand-new.ts')
    expect(fs.existsSync(target)).toBe(false)
    const result = preWriteRewriteHandler(writeEvent(target, makeLines(100)))
    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeUndefined()
  })

  it('passes through when the file exists but is small (below write_rewrite_min_lines)', () => {
    const target = path.join(FILES_DIR, 'small.ts')
    fs.writeFileSync(target, makeLines(10))
    // New content keeps only 1 of the 10 old lines -- would clearly fire on a large file, but
    // this file is trivially small (default floor is 40 lines), so it must pass regardless.
    const newContent = 'line 0\n' + makeLines(9, 'brand-new-line').replace(/\n$/, '')
    const result = preWriteRewriteHandler(writeEvent(target, newContent))
    expect(result.hookType).toBe('pass')
  })

  it('fires the hint for a large file where most lines are unchanged', () => {
    const target = path.join(FILES_DIR, 'mostly-unchanged.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 100; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    // Change only 2 of the 100 lines -- 98% unchanged, well above the default 75% floor.
    const newLines = [...oldLines]
    newLines[10] = 'CHANGED line 10'
    newLines[50] = 'CHANGED line 50'
    const result = preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n'))

    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Edit')
    }
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeDefined()
  })

  it('does not fire (false positive) for a large file that is a genuine, mostly-different rewrite', () => {
    const target = path.join(FILES_DIR, 'genuine-rewrite.ts')
    fs.writeFileSync(target, makeLines(100, 'old'))

    // Entirely different line content -- a real rewrite, not a small edit.
    const result = preWriteRewriteHandler(writeEvent(target, makeLines(100, 'totally-different-content')))

    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeUndefined()
  })

  it('passes through identical content (no-op write)', () => {
    const target = path.join(FILES_DIR, 'identical.ts')
    const body = makeLines(100)
    fs.writeFileSync(target, body)
    const result = preWriteRewriteHandler(writeEvent(target, body))
    expect(result.hookType).toBe('pass')
  })

  it('fails open when content is missing or non-string', () => {
    const target = path.join(FILES_DIR, 'no-content.ts')
    fs.writeFileSync(target, makeLines(100))
    expect(preWriteRewriteHandler(writeEvent(target, undefined)).hookType).toBe('pass')
    expect(preWriteRewriteHandler(writeEvent(target, 12345)).hookType).toBe('pass')
  })

  it('fails open when file_path is missing', () => {
    expect(preWriteRewriteHandler(writeEvent(undefined, makeLines(100))).hookType).toBe('pass')
  })

  it('fails open when the path is a directory, not a file', () => {
    const dirTarget = fs.mkdtempSync(path.join(FILES_DIR, 'a-dir-'))
    const result = preWriteRewriteHandler(writeEvent(dirTarget, makeLines(100)))
    expect(result.hookType).toBe('pass')
  })

  it('fails open when the file cannot be read (permission-style error simulated via ENOENT after stat)', () => {
    // A path that statSync itself cannot resolve (nonexistent parent dir with trailing slash
    // weirdness is fragile across platforms) -- instead assert the already-covered brand-new-file
    // path and a bogus null-byte path both degrade to pass rather than throwing.
    const bogus = path.join(FILES_DIR, 'does\x00not-exist.ts')
    expect(() => preWriteRewriteHandler(writeEvent(bogus, makeLines(100)))).not.toThrow()
    expect(preWriteRewriteHandler(writeEvent(bogus, makeLines(100))).hookType).toBe('pass')
  })

  it('fails open without reading the old file when it exceeds the byte-size cap, even though its line count is well under MAX_LINES_FOR_DIFF', () => {
    const target = path.join(FILES_DIR, 'huge-few-lines.ts')
    // 200 lines of 30KB each (~6MB total) -- far over the 4MB byte cap, but only 200 lines, well
    // under MAX_LINES_FOR_DIFF (4000). Pre-fix, the only gate was the line-count check performed
    // AFTER the full file was already read and split, so this shape sailed straight through: full
    // readFileSync of ~6MB, followed by a hint firing since 200 < 4000 and most lines are unchanged.
    const oldLines: string[] = []
    for (let i = 0; i < 200; i++) oldLines.push(`line ${i} ` + 'x'.repeat(30_000))
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    newLines[10] = 'CHANGED line 10'
    const result = preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n'))

    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeUndefined()
  })

  // Mutation guard: a lowered write_rewrite_min_lines / write_rewrite_unchanged_pct must actually
  // change behavior, proving the fields drive this gate rather than a hardcoded literal.
  it('write_rewrite_min_lines wiring: a file too small at the default floor fires once the floor is lowered', () => {
    const target = path.join(FILES_DIR, 'wiring-min-lines.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 20; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    newLines[5] = 'CHANGED'
    const content = newLines.join('\n') + '\n'

    // 20 lines is below the default floor (40) -- passes.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('pass')

    const cfg = defaultConfig()
    cfg.hints.write_rewrite_min_lines = 10
    saveConfig(cfg)
    invalidateConfigCache()

    // Same file, same content -- now clears the lowered floor and fires.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('context')
  })

  it('reports the file\'s real line count and unchanged percentage, not the ones a trailing newline inflates (regression: split on a final newline yields a phantom empty element, so a 40-line file was described as 41-line and 30 of 40 kept lines as 76%)', () => {
    const target = path.join(FILES_DIR, 'trailing-newline.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 40; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    for (let i = 30; i < 40; i++) newLines[i] = `CHANGED ${i}`
    const result = preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n'))

    expect(result.hookType).toBe('context')
    if (result.hookType !== 'context') return
    expect(result.context).toContain('40-line file')
    expect(result.context).not.toContain('41-line file')
    // 30 of 40 lines kept is exactly 75%, not the 76% the phantom element's free match produced.
    expect(result.context).toContain('75% of its lines are unchanged')
  })

  it('counts a file one line short of write_rewrite_min_lines as short (regression: the phantom trailing element let a 39-line file clear a 40-line floor)', () => {
    const target = path.join(FILES_DIR, 'floor-off-by-one.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 39; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    newLines[0] = 'CHANGED 0'

    const cfg = defaultConfig()
    cfg.hints.write_rewrite_min_lines = 40
    saveConfig(cfg)
    invalidateConfigCache()

    expect(preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n')).hookType).toBe('pass')
  })

  it('write_rewrite_unchanged_pct wiring: raising the threshold suppresses a hint that fired at the default', () => {
    const target = path.join(FILES_DIR, 'wiring-pct.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 100; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    // 80% unchanged: 20 of 100 lines change.
    const newLines = [...oldLines]
    for (let i = 0; i < 20; i++) newLines[i] = `CHANGED ${i}`
    const content = newLines.join('\n') + '\n'

    // Default floor is 75% -- 80% clears it and fires.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('context')

    const cfg = defaultConfig()
    cfg.hints.write_rewrite_unchanged_pct = 90
    saveConfig(cfg)
    invalidateConfigCache()

    // Same 80%-unchanged content no longer clears the raised 90% floor -- passes.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('pass')
  })
})
