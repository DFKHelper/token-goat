/** The curl HTML fold redacted the text extractCleanText returned, and extractCleanText is a truncator: html-to-text cuts its input at `limits.maxInputLength`, 1 << 24 by default, with no marker. A GitHub token straddling that cut was split before the redactor saw it, the fragment was shorter than its pattern, and it shipped. The fold now redacts the page before extraction as well as after, and extractCleanText's limit reaches MAX_CAPTURE_BYTES. A 16 MB page is too slow and too large for the suite, so the fold below runs the real extractCleanText with a 4 KB limit, the parameter it takes for this, and the default is checked on the options html-to-text receives. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HtmlToText from 'html-to-text'
import type * as WebExtract from '../src/web_extract.js'
import { tempConfigPath } from './helpers/temp-config.js'

const CUT = 4096
const optionsSeen: Array<{ limits?: { maxInputLength?: number } } | undefined> = []

const _testConfigPath = tempConfigPath('tg-curl-html-cut-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
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

import { MAX_CAPTURE_BYTES } from '../src/bash_runner.js'
import { invalidateConfigCache } from '../src/config.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { clearModuleCaches } from '../src/reset.js'
import { redactSecrets } from '../src/secret_redact.js'
import { makeHookEvent } from './helpers/hook-event.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const INSIDE = 30

// HAND-DERIVED: a page whose inline CSS pushes the token so that the cut falls 30 characters into it, with markup after it the cut discards.
const PAGE = (() => {
  const lead = '<!DOCTYPE html><html><head><title>Deploy notes</title><style>'
  const tail = '</style></head><body><article><p>Set GITHUB_TOKEN='
  const filler = '.f{color:#000}\n'.repeat(Math.floor((CUT - INSIDE - lead.length - tail.length) / 15))
  const css = filler + ' '.repeat(CUT - INSIDE - lead.length - tail.length - filler.length)
  return `${lead}${css}${tail}${TOKEN} before the deploy step.</p><p>${'More notes. '.repeat(400)}</p></article></body></html>`
})()

function postEvent(command: string, output: string) {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 's',
    raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode: 0 } },
  })
}

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

describe('the curl HTML fold redacts before html-to-text can cut a credential in two', () => {
  it('the fixture puts the cut inside the token, leaving a fragment redaction alone does not catch', async () => {
    const actual = await vi.importActual<typeof WebExtract>('../src/web_extract.js')
    expect(PAGE.indexOf(TOKEN)).toBe(CUT - INSIDE)
    const fragment = actual.extractCleanText(PAGE, CUT)
    expect(fragment.endsWith(TOKEN.slice(0, INSIDE))).toBe(true)
    expect(redactSecrets(fragment).text).toContain(TOKEN.slice(0, INSIDE))
  })

  it('ships no part of a token the cut split', async () => {
    const res = await postBashHandler(postEvent('curl -s https://example.com/deploy-notes', PAGE))
    expect(res.hookType, 'the fixture must reach the curl HTML fold or this case tests nothing').toBe('rewriteOutput')
    if (res.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(res.updatedOutput).toContain('curl HTML body cleaned')
    expect(res.updatedOutput).toContain('Set GITHUB_TOKEN=')
    expect(res.updatedOutput).not.toMatch(/ghp_[A-Za-z0-9]{6,}/)
  })

  it('gives html-to-text an input limit no smaller than the largest capture', async () => {
    const actual = await vi.importActual<typeof WebExtract>('../src/web_extract.js')
    actual.extractCleanText('<html><body><p>hi</p></body></html>')
    expect(optionsSeen).toHaveLength(1)
    expect(optionsSeen[0]?.limits?.maxInputLength ?? 0).toBeGreaterThanOrEqual(MAX_CAPTURE_BYTES)
  })
})
