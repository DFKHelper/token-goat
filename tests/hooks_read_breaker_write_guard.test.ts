/** The re-read denial circuit breaker and the Write blind-drop guard compose: a whole-file denial loop the breaker ends hands over one real read the Write guard counts as seen, while a line-range retry is redirected once and then locked for that same range, so a refused retry is never counted as seen. Provenance: HAND-DERIVED from a 200-line file; the whole-file rows read it unranged, the range rows serve its first 60 lines; the first version of the range sequence was driven through the built hook entry (PreToolUse/PostToolUse payloads with Read and Write tool inputs) and printed the deny, the breaker's advisory note, and the blind-drop refusal quoted in the merge report. The range rows pin main's 44e95a016, where a refused range read locks later slices instead of going through the breaker (the fileRereadDenyKey comment in src/hooks_read.ts). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-breaker-write-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')
// The recent-read protection window waves through the four most recently read files, so a lone file's whole-file re-read would never be denied without this.
fs.writeFileSync(TEST_CONFIG_PATH, '[hints]\nprotect_recent_reads = 0\nreread_deny = true\n', 'utf8')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

const { preReadHandler } = await import('../src/hooks_read.js')
const { postReadHandler } = await import('../src/hooks_read_post.js')
const { preWriteRewriteHandler } = await import('../src/hooks_write.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')

const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-breaker-write-files-'))
const LINES = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i} // line ${i + 1}`)
const WHOLE = LINES.join('\n') + '\n'
const FIRST_60_ONLY = LINES.slice(0, 60).join('\n') + '\n'

beforeEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
})

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } finally {
    fs.rmSync(FILES_DIR, { recursive: true, force: true })
  }
})

let counter = 0

function seed(extension: string): string {
  const target = path.join(FILES_DIR, `b${++counter}.${extension}`)
  fs.writeFileSync(target, WHOLE)
  return target
}

function rangeReadEvent(eventName: 'pre_tool_use' | 'post_tool_use', file: string) {
  return makeHookEvent({ eventName, toolName: 'Read', toolInput: { file_path: file, offset: 1, limit: 60 }, sessionId: 'breaker-write' })
}

function wholeReadEvent(eventName: 'pre_tool_use' | 'post_tool_use', file: string) {
  return makeHookEvent({ eventName, toolName: 'Read', toolInput: { file_path: file }, sessionId: 'breaker-write' })
}

function writeEvent(file: string, content: string) {
  return makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Write', toolInput: { file_path: file, content }, sessionId: 'breaker-write' })
}

/** Read the whole file, retry it (denied: every line was already served), then retry again until the breaker lets it through. A .csv has no snapshot-diff deny ahead of the breaker, so the deny that fires is the one the breaker covers. */
function wholeFileLoopUntilBreaker(file: string): void {
  expect(preReadHandler(wholeReadEvent('pre_tool_use', file)).hookType, 'the first read passes').not.toBe('deny')
  postReadHandler(wholeReadEvent('post_tool_use', file))
  expect(preReadHandler(wholeReadEvent('pre_tool_use', file)).hookType, 'the first retry is denied').toBe('deny')
  expect(preReadHandler(wholeReadEvent('pre_tool_use', file)).hookType, 'the second retry is let through by the breaker').not.toBe('deny')
  postReadHandler(wholeReadEvent('post_tool_use', file))
}

/** Serve lines 1-60 and leave the file read in part. */
function serveFirstWindow(file: string): void {
  preReadHandler(rangeReadEvent('pre_tool_use', file))
  postReadHandler(rangeReadEvent('post_tool_use', file))
}

describe('the re-read circuit breaker and the Write blind-drop guard', () => {
  it('a Write that keeps every line passes after the breaker let a whole-file retry through', async () => {
    const target = seed('csv')
    wholeFileLoopUntilBreaker(target)
    expect((await preWriteRewriteHandler(writeEvent(target, WHOLE + '// added\n'))).hookType).not.toBe('deny')
  })

  it('a Write that drops lines passes after the breaker let a whole-file retry through, because that retry delivered the whole file', async () => {
    const target = seed('csv')
    wholeFileLoopUntilBreaker(target)
    expect((await preWriteRewriteHandler(writeEvent(target, FIRST_60_ONLY))).hookType).toBe('pass')
  })

  // 327205222 ("lock line-range retries") reversed bf14d04ad: the redirect is spent on the first retry, then the range stays locked; tests/hooks_read.test.ts 'keeps an exact served range locked after its first redirect' pins the same rule.
  it('keeps the second identical line-range retry locked after one redirect, and keeps a shifted window denied', () => {
    const target = seed('ts')
    serveFirstWindow(target)
    const first = preReadHandler(rangeReadEvent('pre_tool_use', target))
    expect(first.hookType, 'the first retry is denied').toBe('deny')
    const second = preReadHandler(rangeReadEvent('pre_tool_use', target))
    expect(second.hookType, 'the second identical range retry stays denied').toBe('deny')
    if (second.hookType === 'deny') expect(second.message).toContain('Line-range reads of this file are locked')
    const shifted = preReadHandler(makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: target, offset: 2, limit: 58 }, sessionId: 'breaker-write' }))
    expect(shifted.hookType, 'a shifted window inside the served lines stays denied').toBe('deny')
  })

  it('still refuses a Write that drops lines nobody saw after line-range retries', async () => {
    const target = seed('ts')
    serveFirstWindow(target)
    preReadHandler(rangeReadEvent('pre_tool_use', target))
    preReadHandler(rangeReadEvent('pre_tool_use', target))
    const out = await preWriteRewriteHandler(writeEvent(target, FIRST_60_ONLY))
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') expect(out.message).toContain('lines 61-200')
  })
})
