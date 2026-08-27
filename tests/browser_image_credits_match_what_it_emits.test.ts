/**
 * `postBrowserImageHandler` has two shrink branches and one text branch, and each of the three had
 * a distinct accounting defect.
 *
 * The already-shown-screenshot branch credited base64 CHARACTERS (`originalDataUrl.length`) while
 * the shrink branch beside it credits DECODED bytes, and both file under the same `image_shrink`
 * kind. Base64 inflates by 4/3, so a repeat screenshot booked roughly a third more than an
 * identical shrink of the same pixels, and `token-goat stats` summed the two units into one row.
 *
 * The Tab Context dedup branch replaced a repeated tab listing with a short placeholder and
 * recorded nothing at all, so the entire mechanism was absent from the ledger.
 *
 * Both expectations below are derived from an independent measurement of the artifact the handler
 * actually emitted (decode the fixture, measure the returned string), never from the arithmetic
 * the handler itself performs.
 */
import { tempConfigPath } from './helpers/temp-config.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const _testConfigPath = tempConfigPath('tg-browser-credit-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

// Spy while calling through, matching tests/poll_handlers_record_their_savings.test.ts.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { postBrowserImageHandler } from '../src/hooks_browser_image.js'
import { clearModuleCaches } from '../src/reset.js'
import { invalidateConfigCache } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { recordStat, kindToSource } from '../src/stats.js'
import type { HookEvent } from '../src/hook_registry.js'

const SCREENSHOT_NOTICE =
  '[token-goat: screenshot identical to one already shown this session; not re-sent. Nothing on the page has changed since.]'
const TAB_NOTICE = '(tabs unchanged since last check)'

let jpegB64: string
let jpegDecodedBytes: number

beforeAll(async () => {
  const side = 3000
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256
  const jpeg = await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer()
  jpegB64 = jpeg.toString('base64')
  jpegDecodedBytes = jpeg.length
})

beforeEach(() => {
  clearModuleCaches()
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
})

function imageEvent(dataB64: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'mcp__claude-in-chrome__computer',
    toolInput: {},
    sessionId: 'credit-test',
    raw: {
      tool_response: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataB64 } }] },
    },
  })
}

function tabEvent(text: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'mcp__claude-in-chrome__computer',
    toolInput: {},
    sessionId: 'credit-test',
    raw: { tool_response: { content: [{ type: 'text', text }] } },
  })
}

function callsFor(kind: string): unknown[][] {
  return vi.mocked(recordStat).mock.calls.filter((c) => c[0] === kind)
}

describe('browser image handler credits the unit its stat kind is denominated in', () => {
  it('credits a repeat screenshot in decoded image bytes, the same unit its shrink sibling uses', async () => {
    await postBrowserImageHandler(imageEvent(jpegB64))
    vi.mocked(recordStat).mockClear()

    const second = await postBrowserImageHandler(imageEvent(jpegB64))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return
    expect(second.updatedOutput).toBe(SCREENSHOT_NOTICE)

    const calls = callsFor('image_shrink')
    expect(calls.length, 'the repeat-screenshot branch must record exactly one image_shrink row').toBe(1)

    // Independent measurement: decode the fixture ourselves and subtract the literal notice the handler returned.
    const expectedBytes = jpegDecodedBytes - Buffer.byteLength(second.updatedOutput, 'utf-8')
    expect(calls[0]!.slice(0, 3), 'a repeat screenshot must be credited in decoded bytes, not base64 characters').toEqual([
      'image_shrink',
      expectedBytes,
      Math.round(expectedBytes / 4),
    ])

    // The pre-fix number, pinned as a control so a regression back to base64 characters cannot pass this file. 4/3 inflation makes it strictly larger, so the two can never coincide.
    const base64Credit = `data:image/jpeg;base64,${jpegB64}`.length - SCREENSHOT_NOTICE.length
    expect(base64Credit).toBeGreaterThan(expectedBytes)
    expect(calls[0]![1], 'the base64-character figure is the defect this pins against').not.toBe(base64Credit)
  })

  it('credits a repeat screenshot no more than a shrink of the same image would, since both are the same kind', async () => {
    // The defect was invisible in a single row: it only shows when the two branches of one kind are compared. A repeat drops the whole image, so its credit is the upper bound any shrink of the same pixels could book.
    const shrunk = await postBrowserImageHandler(imageEvent(jpegB64))
    expect(shrunk.hookType).toBe('rewriteOutput')
    const shrinkCredit = callsFor('image_shrink')[0]![1] as number
    vi.mocked(recordStat).mockClear()

    await postBrowserImageHandler(imageEvent(jpegB64))
    const repeatCredit = callsFor('image_shrink')[0]![1] as number

    expect(shrinkCredit).toBeLessThan(jpegDecodedBytes)
    expect(repeatCredit, 'dropping the image entirely cannot save less than shrinking it').toBeGreaterThan(shrinkCredit)
    expect(repeatCredit, 'nor can it save more than the whole decoded image').toBeLessThan(jpegDecodedBytes)
  })

  it('credits the Tab Context dedup, measured against the placeholder it emitted', async () => {
    const tabs = `\nTab Context:\n${Array.from({ length: 40 }, (_, i) => `  tab ${i}: https://example.invalid/page/${i} -- Some Page Title ${i}`).join('\n')}`

    const first = await postBrowserImageHandler(tabEvent(tabs))
    expect(first.hookType, 'a first-seen tab listing is passed through unchanged').toBe('pass')
    expect(callsFor('browser_tab_dedup').length, 'nothing is saved the first time, so nothing may be credited').toBe(0)

    const second = await postBrowserImageHandler(tabEvent(tabs))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return
    expect(second.updatedOutput).toBe(TAB_NOTICE)

    const calls = callsFor('browser_tab_dedup')
    expect(calls.length, 'a collapsed repeat tab listing must be credited exactly once').toBe(1)

    const expectedBytes = Buffer.byteLength(tabs, 'utf-8') - Buffer.byteLength(second.updatedOutput, 'utf-8')
    expect(calls[0]!.slice(0, 3), 'the credit must equal the original minus the string actually emitted').toEqual([
      'browser_tab_dedup',
      expectedBytes,
      Math.round(expectedBytes / 4),
    ])
    expect(kindToSource('browser_tab_dedup'), 'a real rewrite belongs under content, not filed as "other"').toBe('content')
  })

  it('credits nothing when the net-benefit gate declines to collapse a short repeat', async () => {
    const tabs = '\nTab Context:\n  tab 0: a'
    await postBrowserImageHandler(tabEvent(tabs))
    const second = await postBrowserImageHandler(tabEvent(tabs))
    expect(second.hookType, 'the placeholder is longer than the listing, so no rewrite fires').toBe('pass')
    expect(callsFor('browser_tab_dedup').length).toBe(0)
  })
})
