/**
 * HTML-to-clean-text folding on the Bash post-hook for a `curl` GET (`hooks_bash.ts`
 * `maybeFoldCurlHtml`). `curl https://example.com/article` run through Bash returns raw HTML, and
 * Claude Code delivers only the first ~20,000 bytes of a Bash result inline (`src/delivery_cap.ts`).
 * On a real page those bytes are usually `<head>`, inline CSS, and `<script>`, so the model can pay
 * the full cap and still receive zero article content. `src/hooks_fetch.ts` already solves this for
 * WebFetch via `looksLikeHtml` + `extractCleanText` (`src/web_extract.ts`); this closes the same gap
 * on the Bash surface.
 *
 * Fixture provenance: HAND-DERIVED. `LARGE_HTML_PAGE` is a hand-written page (not captured from any
 * real site) built to a fixed shape: `HEAD_PADDING` alone exceeds 20,000 bytes so the article text
 * cannot appear in the first 20,000 bytes of the raw fixture, and `ARTICLE_MARKER` is a unique string
 * placed only inside the article body. It is comfortably larger than the net-benefit floor so a fold
 * assertion here is not measuring a fixture sitting at the floor.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tempConfigPath } from './helpers/temp-config.js'

const _testConfigPath = tempConfigPath('tg-curl-html-fold-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { postBashHandler } from '../src/hooks_bash.js'
import { invalidateConfigCache } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { extractCleanText } from '../src/web_extract.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const ARTICLE_MARKER = 'QUICK_BROWN_FOX_ARTICLE_BODY_MARKER_7f3a'

/** Head/CSS/script filler comfortably past the ~20,000-byte harness delivery cap. */
const HEAD_PADDING = '<style>.filler{color:#000;}</style>\n'.repeat(700)
if (HEAD_PADDING.length <= 20000) throw new Error('HEAD_PADDING must exceed the 20,000-byte delivery cap for this test to be meaningful')

const LARGE_HTML_PAGE =
  `<!DOCTYPE html><html><head><title>Test Article</title>${HEAD_PADDING}</head>` +
  `<body><article><p>${ARTICLE_MARKER} this is the real article content a reader wants.</p></article></body></html>`

// Pretty-printed (indented) so it is large and structurally similar in size profile to a real API
// response, while still failing `looksLikeHtml`'s DOCTYPE/html/body sniff.
const LARGE_JSON_BODY = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'item-' + i, note: 'padding'.repeat(5) })) }, null, 2)

const NON_HTML_LARGE_TEXT = 'plain log line with no markup\n'.repeat(700)

// HAND-DERIVED: prose composed here independently of the fold's logic, and deliberately prose-heavy
// rather than markup-heavy, because the clip path runs only when extractCleanText's OUTPUT overruns
// the delivery cap. Measured against three real pages this is the common case, not the exotic one: a
// 197,504-byte Wikipedia article cleans to 29,252 bytes, still half again over the cap.
const PROSE_HEAVY_PAGE =
  '<!DOCTYPE html><html><head><title>Long</title></head><body><article>' +
  '<p>A paragraph of ordinary article prose, long enough that the cleaned text is dominated by words rather than by the markup that carried them.</p>\n'.repeat(220) +
  '</article></body></html>'

function postEvent(command: string, output: string, exitCode = 0, sessionId = 's') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: {
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: output, exitCode },
    },
  })
}

const ORIG_BC = process.env['TOKEN_GOAT_BASH_COMPRESS']

describe('postBashHandler: curl HTML body cleaned via extractCleanText', () => {
  beforeEach(() => {
    clearModuleCaches()
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // no config file -> defaults (enabled, nothing disabled)
    }
    delete process.env['TOKEN_GOAT_BASH_COMPRESS']
    invalidateConfigCache()
  })

  afterEach(() => {
    if (ORIG_BC === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
    else process.env['TOKEN_GOAT_BASH_COMPRESS'] = ORIG_BC
    invalidateConfigCache()
  })

  afterAll(() => {
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ignore
    }
  })

  it('folds a large HTML page from a curl GET and surfaces article text absent from the raw head', async () => {
    // Anti-vacuity guard: assert the fold is a real, meaningful shrink before asserting anything
    // about its content, so this line is the one that fails if the fixture ever stops clearing the
    // net-benefit floor and both sides silently collapse to the untouched input.
    const res = await postBashHandler(postEvent('curl -s https://example.com/article', LARGE_HTML_PAGE))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(res.updatedOutput.length).toBeLessThan(LARGE_HTML_PAGE.length * 0.5)

    // The marker never appears in the first 20,000 bytes of the raw fixture: the harness's own
    // delivery cap would have shown zero article content without this fold.
    expect(LARGE_HTML_PAGE.slice(0, 20000)).not.toContain(ARTICLE_MARKER)
    expect(res.updatedOutput).toContain(ARTICLE_MARKER)
    expect(res.updatedOutput).not.toContain('<style>')
    expect(res.updatedOutput).not.toContain('<article>')
  })

  it('emits a recall notice naming --full, not a bare bash-output pointer', async () => {
    const res = await postBashHandler(postEvent('curl -s https://example.com/article', LARGE_HTML_PAGE))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(res.updatedOutput).toMatch(/token-goat bash-output [0-9a-f]+ --full/)
    const idMatch = /token-goat bash-output ([0-9a-f]+) --full/.exec(res.updatedOutput)
    expect(idMatch).not.toBeNull()
  })

  it('leaves a curl GET returning JSON untouched', async () => {
    const res = await postBashHandler(postEvent('curl -s https://api.example.com/items', LARGE_JSON_BODY))
    expect(res.hookType).not.toBe('rewriteOutput')
  })

  it('leaves a non-curl command emitting HTML untouched by this fold (no --full recall notice)', async () => {
    // `npm run build` reaches the same cached branch as a curl GET (it is the other command shape
    // that lands there alongside monitoring/build commands), so this actually exercises the
    // `isCurlGetCommand` guard inside the fold rather than being routed away before ever reaching
    // it -- a bare `cat` command never gets that far, so it would pass vacuously.
    const res = await postBashHandler(postEvent('npm run build', LARGE_HTML_PAGE))
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).not.toMatch(/curl HTML body cleaned/)
    }
  })

  it('leaves plain non-HTML output from a curl GET untouched by this fold', async () => {
    const res = await postBashHandler(postEvent('curl -s https://example.com/log.txt', NON_HTML_LARGE_TEXT))
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).not.toMatch(/curl HTML body cleaned/)
    }
  })

  it('honours the disabled_filters opt-out for this filter', async () => {
    fs.writeFileSync(_testConfigPath, '[bash_compress]\ndisabled_filters = ["curl-html"]\n')
    invalidateConfigCache()
    const res = await postBashHandler(postEvent('curl -s https://example.com/article', LARGE_HTML_PAGE))
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).not.toMatch(/curl HTML body cleaned/)
    } else {
      expect(res.hookType).not.toBe('rewriteOutput')
    }
  })

  it('clips cleaned text to the delivery cap, keeping the recall notice and the closing fence', async () => {
    // The harness truncates a Bash result from the END, and this is the one rewrite in hooks_bash.ts whose output can legitimately overrun the cap, so an unclipped fold loses its trailing bytes: the closing fence marker and, expensively, the recall notice. That notice matters more than it looks, because the harness persists the CLEANED text it was handed -- once this hook substitutes, the raw markup lives only in token-goat's bash cache and the notice is its only route back.
    const saved = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    try {
      clearModuleCaches()
      invalidateConfigCache()
      // Precondition, not the oracle: calling the producer here only establishes that this fixture actually reaches the clip path. The assertions below are independent of it -- they check a byte ceiling, a leading notice and a closed fence, none of which extractCleanText computes.
      expect(Buffer.byteLength(extractCleanText(PROSE_HEAVY_PAGE), 'utf-8')).toBeGreaterThan(20000)

      const res = await postBashHandler(postEvent('curl -s https://example.com/long', PROSE_HEAVY_PAGE, 0, 'clip'))
      expect(res.hookType).toBe('rewriteOutput')
      if (res.hookType !== 'rewriteOutput') throw new Error('unreachable')
      expect(Buffer.byteLength(res.updatedOutput, 'utf-8')).toBeLessThanOrEqual(20000)
      expect(res.updatedOutput.startsWith('[token-goat: curl HTML body cleaned')).toBe(true)
      expect(res.updatedOutput).toMatch(/token-goat bash-output [0-9a-f]+ --full/)
      expect(res.updatedOutput).toContain('</untrusted-tool-output>')
      // Unescaped: the clip note is token-goat's own sentence and belongs outside the fence, which escapes `[token-goat:` markers found inside it so third-party bytes cannot forge one.
      expect(res.updatedOutput).toContain('[token-goat: cleaned text clipped to the harness delivery cap')
      expect(res.updatedOutput).not.toContain('&#91;token-goat: cleaned text clipped')
    } finally {
      if (saved === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
      else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = saved
      clearModuleCaches()
      invalidateConfigCache()
    }
  })

  it('honours the TOKEN_GOAT_BASH_COMPRESS=0 kill switch', async () => {
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    invalidateConfigCache()
    const res = await postBashHandler(postEvent('curl -s https://example.com/article', LARGE_HTML_PAGE))
    expect(res.hookType).not.toBe('rewriteOutput')
  })
})
