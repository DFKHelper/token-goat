/** The re-read denial circuit breaker and the Write blind-drop guard compose: a denial loop the breaker ends never turns a refused retry into a view the Write guard counts as seen. Provenance: HAND-DERIVED from a 200-line file whose first 60 lines are served; the same sequence was driven through the built hook entry (PreToolUse/PostToolUse payloads with Read and Write tool inputs) and printed the deny, the breaker's advisory note, and the blind-drop refusal quoted in the merge report. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-breaker-write-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

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

let counter = 0

function seed(): string {
  const target = path.join(FILES_DIR, `b${++counter}.ts`)
  fs.writeFileSync(target, WHOLE)
  return target
}

function readEvent(eventName: 'pre_tool_use' | 'post_tool_use', file: string) {
  return makeHookEvent({ eventName, toolName: 'Read', toolInput: { file_path: file, offset: 1, limit: 60 }, sessionId: 'breaker-write' })
}

function writeEvent(file: string, content: string) {
  return makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Write', toolInput: { file_path: file, content }, sessionId: 'breaker-write' })
}

/** Serve lines 1-60, then retry the same read until the breaker lets it through. */
function serveThenLoopUntilBreaker(file: string): void {
  preReadHandler(readEvent('pre_tool_use', file))
  postReadHandler(readEvent('post_tool_use', file))
  expect(preReadHandler(readEvent('pre_tool_use', file)).hookType, 'the first retry is denied').toBe('deny')
  expect(preReadHandler(readEvent('pre_tool_use', file)).hookType, 'the second retry is let through by the breaker').not.toBe('deny')
  postReadHandler(readEvent('post_tool_use', file))
}

describe('the re-read circuit breaker and the Write blind-drop guard', () => {
  it('still refuses a Write that drops lines nobody saw after the breaker let a retry through', async () => {
    const target = seed()
    serveThenLoopUntilBreaker(target)
    const out = await preWriteRewriteHandler(writeEvent(target, FIRST_60_ONLY))
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') expect(out.message).toContain('lines 61-200')
  })

  it('does not refuse a Write that keeps every line, so the guard is not simply denying after the loop', async () => {
    const target = seed()
    serveThenLoopUntilBreaker(target)
    expect((await preWriteRewriteHandler(writeEvent(target, WHOLE + '// added\n'))).hookType).not.toBe('deny')
  })
})
