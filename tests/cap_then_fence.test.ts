/** pr-slice and html-query capped their output after fencing it. The overflow cap keeps leading lines only, so on a long PR diff or HTML page it cut the closing tag off and left the fence open, with token-goat's own cap marker inside it. These drive both commands past a small cap and check that the closing tag survives and the marker follows it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { invalidateConfigCache } from '../src/config.js'
import { UNTRUSTED_GITHUB_TAG, UNTRUSTED_HTML_TAG } from '../src/injection_scan.js'

const spawnSyncMock = vi.fn()
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, spawnSync: (...args: unknown[]) => spawnSyncMock(...args) }
})

// PROVENANCE HAND-DERIVED: a unified diff written by hand in git's own `diff --git` / `@@` hunk shape, and an HTML page of plain paragraphs; neither is read from our parser or formatter.
const LINES = 400

const dirs: string[] = []
beforeEach(() => {
  spawnSyncMock.mockReset()
  process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '200'
  invalidateConfigCache()
})
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
  delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
  invalidateConfigCache()
})

function capture(fn: () => number | void): string {
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
  fn()
  vi.restoreAllMocks()
  return out
}

/** The fence closes, and the cap marker comes after the closing tag rather than inside the fence. */
function expectClosedThenMarker(out: string, tag: string): void {
  const close = out.lastIndexOf(`</${tag}>`)
  const marker = out.indexOf('[token-goat: output capped')
  expect(out).toContain(`<${tag}>`)
  expect(close, 'the fence is closed').toBeGreaterThan(0)
  expect(marker, 'the output was capped at all').toBeGreaterThan(0)
  expect(marker, 'the cap marker follows the closing tag').toBeGreaterThan(close)
}

describe('a capped fence keeps its closing tag', () => {
  it('pr-slice diff', async () => {
    const { runPrSlice } = await import('../src/read_commands.js')
    const hunk = Array.from({ length: LINES }, (_, i) => `+added line ${i}`)
    const diffText = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', `@@ -0,0 +1,${LINES} @@`, ...hunk].join('\n')
    spawnSyncMock.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0, stdout: diffText })
    expectClosedThenMarker(capture(() => runPrSlice({ pr: '42', slice: 'diff:src/a.ts', repo: 'acme/widgets' })), UNTRUSTED_GITHUB_TAG)
  })

  it('html-query', async () => {
    const { runHtmlQuery } = await import('../src/read_structured_data.js')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-capfence-'))
    dirs.push(dir)
    const file = path.join(dir, 'page.html')
    writeFileSync(file, `<html><body>${Array.from({ length: LINES }, (_, i) => `<p>paragraph ${i}</p>`).join('\n')}</body></html>`)
    expectClosedThenMarker(capture(() => runHtmlQuery({ file, selector: 'p', text: true })), UNTRUSTED_HTML_TAG)
  })
})
