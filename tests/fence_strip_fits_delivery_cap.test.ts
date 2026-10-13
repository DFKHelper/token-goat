/** Two Bash rewrites clip their body to the harness delivery cap before fencing it, reserving what the fence adds, and they priced that as the fenced length minus the raw length. The fence used to only add bytes. It now strips terminal escapes too, so on coloured output that difference shrank or went negative, the clip kept more than the cap holds, and the harness, which truncates a Bash result from the end, would cut off the clip note and with it the closing tag. The other direction failed too. On output dense in markers the neutralizer doubles the body, the reserve priced off the whole text came to more than the cap, and the clip then handed the text back whole: 54,259 bytes shipped. A single line cut just after `[token-goat` escapes a marker the whole line did not, and shipped 4 bytes over. Both rewrites now frame each cut, measure it, and cut again until it fits. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { clipToDeliveryCap, fitToDeliveryCap } from '../src/delivery_cap.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { fenceUntrustedContent, UNTRUSTED_TOOL_TAG } from '../src/injection_scan.js'
import { clearModuleCaches } from '../src/reset.js'
import { BUNDLE } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// PROVENANCE: CAPTURE the Claude Code Bash delivery cap, CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES in src/delivery_cap.ts, restated so the bound is not read off the code under test.
const CAP = 20_000

/** File line N as a colouring tool prints it: a 24-bit SGR before the text and a reset after, about a quarter of the line's bytes. */
function colouredLine(n: number): string {
  return `\x1b[38;2;240;246;252mline ${n}: ${'x'.repeat(60)}\x1b[0m`
}

function lines(lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(colouredLine(n))
  return out.join('\n')
}

function postEvent(command: string, output: string, sessionId: string) {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode: 0 } },
  })
}

let saved: string | undefined

beforeEach(() => {
  saved = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  clearModuleCaches()
  invalidateConfigCache()
})

afterEach(() => {
  if (saved === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = saved
  clearModuleCaches()
  invalidateConfigCache()
})

describe('a rewrite whose fence strips escapes still fits the delivery cap', () => {
  it('served-line elision of a coloured file', async () => {
    await postBashHandler(postEvent("sed -n '800,900p' build.log", lines(800, 900), 'cap-elide'))
    const out = await postBashHandler(postEvent("sed -n '1,900p' build.log", lines(1, 900), 'cap-elide'))
    expect(out.hookType, 'the fixture must reach the elision rewrite').toBe('rewriteOutput')
    if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(out.updatedOutput).toContain('rewrite clipped to the harness delivery cap')
    expect(Buffer.byteLength(out.updatedOutput, 'utf-8')).toBeLessThanOrEqual(CAP)
    expect(out.updatedOutput).toContain(`</${UNTRUSTED_TOOL_TAG}>`)
  })

  it('the curl HTML fold of a page whose text carries escapes', async () => {
    // HAND-DERIVED: html-to-text decodes `&#27;` to ESC, so a page can put escape sequences into the text the fold fences.
    const body = Array.from({ length: 900 }, (_, i) => `<p>&#27;[38;2;240;246;252mline ${i}: ${'x'.repeat(60)}&#27;[0m</p>`).join('\n')
    const page = `<!DOCTYPE html><html><head><title>Log</title></head><body>${body}</body></html>`
    const out = await postBashHandler(postEvent('curl -s https://example.com/build.log', page, 'cap-curl'))
    expect(out.hookType, 'the fixture must reach the curl HTML fold').toBe('rewriteOutput')
    if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(out.updatedOutput).toContain('cleaned text clipped to the harness delivery cap')
    expect(Buffer.byteLength(out.updatedOutput, 'utf-8')).toBeLessThanOrEqual(CAP)
    expect(out.updatedOutput).toContain(`</${UNTRUSTED_TOOL_TAG}>`)
  })
})

// PROVENANCE: the audit's marker-dense shapes. Each `[tg]` is escaped to `&#91;tg]`, so the fenced body is close to twice the raw one.
function denseLines(lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(`[tg] [tg] [tg] [tg] ${n}`)
  return out.join('\n')
}

/** Head padding a cleaned page drops, so the fold pays for itself whatever its body costs. */
const HEAD = `<head><title>Notes</title>${'<style>.filler{color:#000;}</style>\n'.repeat(700)}</head>`

function expectFitsAndCloses(out: Awaited<ReturnType<typeof postBashHandler>>, note: string): void {
  expect(out.hookType, 'the fixture must reach the rewrite').toBe('rewriteOutput')
  if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
  expect(out.updatedOutput).toContain(note)
  expect(Buffer.byteLength(out.updatedOutput, 'utf-8')).toBeLessThanOrEqual(CAP)
  expect(out.updatedOutput).toContain(`</${UNTRUSTED_TOOL_TAG}>`)
}

describe('a rewrite dense in markers still fits the delivery cap', () => {
  it('served-line elision of deny prefixes', async () => {
    await postBashHandler(postEvent("sed -n '800,900p' notes.txt", denseLines(800, 900), 'cap-dense-elide'))
    const out = await postBashHandler(postEvent("sed -n '1,1500p' notes.txt", denseLines(1, 1500), 'cap-dense-elide'))
    expectFitsAndCloses(out, 'rewrite clipped to the harness delivery cap')
  })

  it('the curl HTML fold of a page of deny prefixes', async () => {
    const body = Array.from({ length: 1500 }, () => '<p>[tg] [tg] [tg] [tg]</p>').join('\n')
    const out = await postBashHandler(postEvent('curl -s https://example.com/notes', `<!DOCTYPE html><html>${HEAD}<body>${body}</body></html>`, 'cap-dense-curl'))
    expectFitsAndCloses(out, 'cleaned text clipped to the harness delivery cap')
  })

  it('the curl HTML fold of one line, wherever the cut lands inside a marker', async () => {
    // HAND-DERIVED: `[token-goatX` is not a marker, but a cut right after `[token-goat` leaves one, which the fence then escapes; twelve paddings put the cut at every offset of the twelve-character unit.
    for (let pad = 0; pad < 12; pad++) {
      const line = 'A'.repeat(pad) + '[token-goatX'.repeat(3000)
      const out = await postBashHandler(postEvent(`curl -s https://example.com/line-${pad}`, `<!DOCTYPE html><html>${HEAD}<body><p>${line}</p></body></html>`, `cap-line-${pad}`))
      expectFitsAndCloses(out, 'cleaned text clipped to the harness delivery cap')
    }
  })

  it('fitToDeliveryCap measures the framed cut, and the frame around nothing is the floor', () => {
    const frame = (body: string, clipped: boolean): string => fenceUntrustedContent(body, [], UNTRUSTED_TOOL_TAG) + (clipped ? '\n[note]' : '')
    for (const text of [denseLines(1, 1500), '[token-goatX'.repeat(3000), `<untrusted-x> <untrusted-y>\n`.repeat(2000)]) {
      const fitted = fitToDeliveryCap(text, frame)
      expect(Buffer.byteLength(fitted, 'utf-8')).toBeLessThanOrEqual(CAP)
      expect(fitted.endsWith(`</${UNTRUSTED_TOOL_TAG}>\n[note]`)).toBe(true)
    }
    expect(fitToDeliveryCap('short', frame)).toBe(frame('short', false))
  })

  it('clipToDeliveryCap clips to nothing rather than handing back the text when the framing fills the cap', () => {
    expect(clipToDeliveryCap('x'.repeat(100), CAP + 1)).toEqual({ text: '', clipped: true })
    expect(clipToDeliveryCap('x'.repeat(100), CAP)).toEqual({ text: '', clipped: true })
  })
})

/** The body between the tool-output fence's tags, asserted present, non-empty and made of whole characters. */
function expectWholeBody(text: string, label: string): void {
  const open = `<${UNTRUSTED_TOOL_TAG}>\n`
  const start = text.indexOf(open)
  const end = text.lastIndexOf(`\n</${UNTRUSTED_TOOL_TAG}>`)
  expect(start, `${label}: opening tag`).toBeGreaterThanOrEqual(0)
  expect(end, `${label}: closing tag`).toBeGreaterThan(start)
  const body = text.slice(start + open.length, end)
  expect(body.length, `${label}: the fit shipped an empty body`).toBeGreaterThan(0)
  expect(body, `${label}: a cut decoded half a character`).not.toContain('\u{FFFD}')
  expect(/[\u{D800}-\u{DFFF}]/u.test(body), `${label}: a cut split a surrogate pair`).toBe(false)
  expect(Buffer.byteLength(text, 'utf-8'), label).toBeLessThanOrEqual(CAP)
}

describe('a fitted rewrite keeps a body, cut on a whole character', () => {
  // PROVENANCE: the audit's shapes. A cut through a 2-byte letter decoded to a 3-byte U+FFFD, so every cut overran by the byte it was meant to save, the proportional step repeated the same cut eight times and the empty frame shipped; a dense prefix on one line approached the fit from above and did not reach it in eight; and the elision's character count took the whole of an emoji the byte cut had split.
  it('the curl HTML fold of one paragraph of 2-byte letters, and of a dense prefix', async () => {
    const paragraphs: [string, string][] = [
      ['20,000 U+0436', '\u{436}'.repeat(20_000)],
      ['20,000 U+00E9', '\u{E9}'.repeat(20_000)],
      ['2,250 [tg] then 30,000 x', '[tg]'.repeat(2_250) + 'x'.repeat(30_000)],
    ]
    for (const [i, [label, paragraph]] of paragraphs.entries()) {
      const out = await postBashHandler(postEvent(`curl -s https://example.com/paragraph-${i}`, `<!DOCTYPE html><html>${HEAD}<body><p>${paragraph}</p></body></html>`, `cap-whole-${i}`))
      expect(out.hookType, `${label}: the fixture must reach the curl HTML fold`).toBe('rewriteOutput')
      if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
      expect(out.updatedOutput, label).toContain('cleaned text clipped to the harness delivery cap')
      expectWholeBody(out.updatedOutput, label)
    }
  })

  it('a served-line elision whose unserved line is one long line of CJK or of emoji', async () => {
    for (const [i, [label, long]] of ([
      ['10,000 U+4E2D', '\u{4E2D}'.repeat(10_000)],
      ['15,000 U+1F600', '\u{1F600}'.repeat(15_000)],
    ] as const).entries()) {
      const rows = (lo: number, hi: number): string => {
        const out: string[] = []
        for (let n = lo; n <= hi; n++) out.push(n === 1 ? long : `line ${n}: ${'x'.repeat(60)}`)
        return out.join('\n')
      }
      const session = `cap-elide-long-${i}`
      await postBashHandler(postEvent("sed -n '2,80p' notes.txt", rows(2, 80), session))
      const out = await postBashHandler(postEvent("sed -n '1,80p' notes.txt", rows(1, 80), session))
      expect(out.hookType, `${label}: the fixture must reach the elision rewrite`).toBe('rewriteOutput')
      if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
      expect(out.updatedOutput, label).toContain('rewrite clipped to the harness delivery cap')
      expectWholeBody(out.updatedOutput, label)
    }
  })

  it('fitToDeliveryCap finds the longest fitting cut of a single line whatever its dense prefix', () => {
    const frame = (body: string, clipped: boolean): string => fenceUntrustedContent(body, [], UNTRUSTED_TOOL_TAG) + (clipped ? '\n[note]' : '')
    for (let dense = 0; dense <= 9_500; dense += 125) {
      const text = '[tg]'.repeat(dense) + 'x'.repeat(30_000)
      expectWholeBody(fitToDeliveryCap(text, frame), `dense prefix ${dense}`)
    }
    // Each width at every alignment, so the longest cut that fits lands inside a character at least once: a 4-byte emoji cut after its first byte decodes to a 3-byte U+FFFD that can fit where the whole emoji does not.
    for (const [label, unit, count] of [['U+4E2D', '\u{4E2D}', 10_000], ['U+1F600', '\u{1F600}', 15_000], ['U+0436', '\u{436}', 20_000]] as const) {
      for (let pad = 0; pad < 4; pad++) expectWholeBody(fitToDeliveryCap('a'.repeat(pad) + unit.repeat(count), frame), `${count} ${label} after ${pad}`)
    }
  })
})

describe('a fitted rewrite uses the budget rather than stopping at the last line break', () => {
  const frame = (body: string, clipped: boolean): string => fenceUntrustedContent(body, [], UNTRUSTED_TOOL_TAG) + (clipped ? '\n[note]' : '')
  const bodyOf = (fitted: string): string => fitted.slice(fitted.indexOf(`<${UNTRUSTED_TOOL_TAG}>\n`) + UNTRUSTED_TOOL_TAG.length + 3, fitted.lastIndexOf(`\n</${UNTRUSTED_TOOL_TAG}>`))

  it('cuts inside a long last line instead of dropping it', () => {
    // PROVENANCE: HAND-DERIVED from the audit's informational finding. A short line and then one long one shipped the short line alone, under 1% of the cap.
    const text = `header line\n${'y'.repeat(60_000)}`
    const fitted = fitToDeliveryCap(text, frame)
    expectWholeBody(fitted, 'short line, long line')
    expect(fitted.endsWith('\n[note]')).toBe(true)
    expect(text.startsWith(bodyOf(fitted))).toBe(true)
    expect(Buffer.byteLength(fitted, 'utf-8')).toBeGreaterThan(CAP * 0.95)
  })

  it('ships at least seven eighths of the cap whatever the line lengths, cut on a whole character', () => {
    // A fixed LCG, so every run walks the same shapes: lines from 1 to 4,000 characters of ASCII, 2-byte, 3-byte and 4-byte text.
    let seed = 0x2545f491
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
      return seed % n
    }
    const units = ['x', '\u{436}', '\u{4E2D}', '\u{1F600}']
    for (let trial = 0; trial < 200; trial++) {
      const rows: string[] = []
      let bytes = 0
      while (bytes < 3 * CAP) {
        const row = (units[next(units.length)] ?? 'x').repeat(1 + next(4_000))
        rows.push(row)
        bytes += Buffer.byteLength(row, 'utf-8') + 1
      }
      const text = rows.join('\n')
      const fitted = fitToDeliveryCap(text, frame)
      expectWholeBody(fitted, `trial ${trial}`)
      expect(text.startsWith(bodyOf(fitted)), `trial ${trial}: the body is a prefix of the text`).toBe(true)
      expect(Buffer.byteLength(fitted, 'utf-8'), `trial ${trial}`).toBeGreaterThanOrEqual(CAP * 0.875)
    }
  })

  it('still ends on a whole line when that gives up little', () => {
    const text = Array.from({ length: 1_000 }, (_, i) => `row ${i}: ${'z'.repeat(40)}`).join('\n')
    const body = bodyOf(fitToDeliveryCap(text, frame))
    expect(text.startsWith(`${body}\n`), 'the cut lands on a line break').toBe(true)
  })

  it('clipToDeliveryCap keeps the long line too', () => {
    const clipped = clipToDeliveryCap(`header line\n${'y'.repeat(60_000)}`, 500)
    expect(clipped.clipped).toBe(true)
    expect(Buffer.byteLength(clipped.text, 'utf-8')).toBe(CAP - 500)
  })

  it('an oversized MCP result through the built bundle keeps its long line', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-cap-'))
    try {
      const text = `header line\n${'y'.repeat(60_000)}`
      const payload = { session_id: 'mcp-cap-budget', hook_event_name: 'PostToolUse', cwd: home, tool_name: 'mcp__fixture__fetch_page', tool_input: { url: 'https://example.com' }, tool_response: [{ type: 'text', text }] }
      const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TOKEN_GOAT_HOME: home, TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode' } })
      expect(res.status, res.stderr.slice(0, 400)).toBe(0)
      const shipped = (JSON.parse(res.stdout) as { hookSpecificOutput?: { updatedToolOutput?: unknown } }).hookSpecificOutput?.updatedToolOutput
      expect(typeof shipped).toBe('string')
      // PROVENANCE: CAPTURE MCP_OVERSIZED_THRESHOLD_BYTES in src/hooks_mcp.ts, restated: the rewrite must stay under it.
      expect(Buffer.byteLength(String(shipped), 'utf-8')).toBeLessThan(25_000)
      expect((String(shipped).match(/y/g) ?? []).length).toBeGreaterThan(20_000)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
