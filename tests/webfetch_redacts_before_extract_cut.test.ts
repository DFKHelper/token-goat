/** WebFetch's HTML compression ran extractCleanText on the body as fetched and redacted only the text that came out, and html-to-text cuts its input at `limits.maxInputLength` with no marker, so a credential straddling that cut reached the redactor as a fragment too short to match and shipped. The handler now redacts before extraction as well as after, as the curl HTML fold does. The limit itself could still cut a redacted input, since a placeholder can be longer than the credential it replaced; it is now never below the input's own length. The cut is forced at 20 KB here, the parameter extractCleanText takes for this, since a page past the real limit is too large for the suite. */
import * as fs from 'node:fs'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HtmlToText from 'html-to-text'
import type * as WebExtract from '../src/web_extract.js'
import { tempConfigPath } from './helpers/temp-config.js'

const CUT = 20_000
// HAND-DERIVED: far below a real capture, so an input longer than it is cheap to build. Hoisted, because the module mock below reads it when bash_runner.js is first imported.
const { CAPTURE } = vi.hoisted(() => ({ CAPTURE: 4096 }))
const optionsSeen: Array<{ limits?: { maxInputLength?: number } } | undefined> = []

const _testConfigPath = tempConfigPath('tg-webfetch-extract-cut-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})
vi.mock('../src/bash_runner.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, MAX_CAPTURE_BYTES: CAPTURE }
})
vi.mock('html-to-text', async (importOriginal) => {
  const actual = await importOriginal<typeof HtmlToText>()
  return {
    ...actual,
    htmlToText: (html: string, options?: { limits?: { maxInputLength?: number } }) => {
      optionsSeen.push(options)
      return actual.htmlToText(html, options)
    },
  }
})
vi.mock('../src/web_extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WebExtract>()
  return { ...actual, extractCleanText: (html: string) => actual.extractCleanText(html, CUT) }
})

import { invalidateConfigCache } from '../src/config.js'
import { postFetchHandler } from '../src/hooks_fetch.js'
import { clearModuleCaches } from '../src/reset.js'
import { redactSecrets } from '../src/secret_redact.js'

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const INSIDE = 30

// HAND-DERIVED: inline CSS pushes the token so the cut falls 30 characters into it, past the 16 KB floor WebFetch compression starts at, with markup after it the cut discards.
const PAGE = (() => {
  const lead = '<!DOCTYPE html><html><head><title>Deploy notes</title><style>'
  const tail = '</style></head><body><article><p>Set GITHUB_TOKEN='
  const filler = '.f{color:#000}\n'.repeat(Math.floor((CUT - INSIDE - lead.length - tail.length) / 15))
  const css = filler + ' '.repeat(CUT - INSIDE - lead.length - tail.length - filler.length)
  return `${lead}${css}${tail}${TOKEN} before the deploy step.</p><p>${'More notes. '.repeat(400)}</p></article></body></html>`
})()

beforeEach(() => {
  clearModuleCaches()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // no config file -> defaults
  }
  invalidateConfigCache()
  optionsSeen.length = 0
})

afterAll(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ignore
  }
})

describe('WebFetch redacts before html-to-text can cut a credential in two', () => {
  it('the fixture puts the cut inside the token, leaving a fragment redaction alone does not catch', async () => {
    const actual = await vi.importActual<typeof WebExtract>('../src/web_extract.js')
    expect(PAGE.indexOf(TOKEN)).toBe(CUT - INSIDE)
    const fragment = actual.extractCleanText(PAGE, CUT)
    expect(fragment.endsWith(TOKEN.slice(0, INSIDE))).toBe(true)
    expect(redactSecrets(fragment).text).toContain(TOKEN.slice(0, INSIDE))
  })

  it('ships no part of a token the cut split', () => {
    const res = postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/deploy-notes', prompt: 'summarize' },
      sessionId: 'webfetch-extract-cut',
      agentId: undefined,
      raw: { tool_response: PAGE },
    })
    expect(res.hookType, 'the fixture must reach the WebFetch fence or this case tests nothing').toBe('rewriteOutput')
    if (res.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(res.updatedOutput).toContain('Set GITHUB_TOKEN=')
    expect(res.updatedOutput).not.toMatch(/ghp_[A-Za-z0-9]{6,}/)
  })
})

describe('extractCleanText never cuts an input below its own length', () => {
  it('reads a page longer than the largest capture to its end', async () => {
    const actual = await vi.importActual<typeof WebExtract>('../src/web_extract.js')
    const html = `<html><body><p>${'word '.repeat(2000)}TAIL_MARKER</p></body></html>`
    expect(html.length).toBeGreaterThan(CAPTURE)
    expect(actual.extractCleanText(html)).toContain('TAIL_MARKER')
    expect(optionsSeen).toHaveLength(1)
    expect(optionsSeen[0]?.limits?.maxInputLength ?? 0).toBeGreaterThanOrEqual(html.length)
  })
})
