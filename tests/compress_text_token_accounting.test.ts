/**
 * Regression: `compress-text` billed its saving in bytes but the product bills in tokens.
 *
 * `compressText` deflates the text and base64url-encodes it, then credited `originalBytes - compactBytes`
 * tokens at a flat 4 bytes per token. Measured with tiktoken (cl100k_base and o200k_base) over 120 real
 * repo files, source text runs 3.83-4.22 bytes per token while the base64url payload runs 1.41-1.49: deflate
 * roughly halves the bytes and nearly triples tokens-per-byte, so 118 of those 120 files were token LOSSES.
 * README.md alone was reported as +20893 tokens saved while actually costing ~14093, and the CLI then dumped
 * the 73888-byte payload into context on top of that.
 *
 * These tests pin the two halves of the fix: the token figure is ratio-aware and may be negative, and a losing
 * payload is not inlined by default (with `--payload` preserving the self-contained-blob use case). A genuinely
 * high-compressibility input must still win and still inline -- that case is the guard against over-correcting
 * into "never inline".
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { clearModuleCaches } from '../src/reset.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import {
  compressText,
  BASE64URL_BYTES_PER_TOKEN,
  TEXT_BYTES_PER_TOKEN,
} from '../src/content_store.js'
import { summarize } from '../src/stats.js'

/** Low-compressibility text: pseudo-random words, deterministic so the size ratio never drifts across runs. */
function lowCompressibilityText(): string {
  let seed = 12345
  const words: string[] = []
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    words.push(seed.toString(36))
  }
  return words.join(' ')
}

/** High-compressibility text: a long run of one repeated line, which deflates far below the ~0.35 size ratio where inlining starts to win. */
function highCompressibilityText(): string {
  return 'the same line repeated over and over again\n'.repeat(2000)
}

let home: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined
let envRoot: string

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-compress-tokens-'))
  process.env['TOKEN_GOAT_HOME'] = home
  // Same platform-agnostic derivation tests/content_store.test.ts uses: recordStat writes through dataDir() (env-driven) while summarize(..., home) reads through dataDirForHome(home), and the two agree only when the env root is the exact parent of dataDirForHome's per-platform layout.
  const dataRoot = dataDirForHome(home)
  envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n')
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

/** Run the built bundle against the isolated scratch home so no test ever writes to the real global index. */
function runIsolated(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd: home })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('compressText token accounting', () => {
  it('reports a token COST for a realistic low-compressibility input', () => {
    const result = compressText(lowCompressibilityText())
    expect(result.bytesSaved).toBeGreaterThan(0)
    expect(result.tokensSaved, `expected a token cost for a size ratio of ${(result.compactBytes / result.originalBytes).toFixed(3)}`).toBeLessThan(0)
    expect(result.inlineWins).toBe(false)
  })

  it('still reports a real saving for a genuinely high-compressibility input', () => {
    const result = compressText(highCompressibilityText())
    expect(result.compactBytes / result.originalBytes).toBeLessThan(0.35)
    expect(result.tokensSaved, 'a well-under-0.35 size ratio must still be credited as a win').toBeGreaterThan(0)
    expect(result.inlineWins).toBe(true)
  })

  it('records zero bytes and zero tokens when compression loses', () => {
    compressText(lowCompressibilityText())
    const summary = summarize(0, undefined, home)
    const kind = summary.by_kind['content_compress']
    expect(kind?.events, 'the event must still be recorded so the loss is visible').toBe(1)
    expect(kind?.bytes_saved, 'a losing compression must never book bytes saved').toBe(0)
    expect(kind?.tokens_saved, 'a losing compression must never book tokens saved').toBe(0)
  })
})

describe('compress-text CLI payload gating', () => {
  it('withholds the payload and prints a negative token figure when inlining loses', () => {
    const file = path.join(home, 'low.txt')
    fs.writeFileSync(file, lowCompressibilityText())
    const r = runIsolated(['compress-text', '--file', file])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/tokens_saved: -\d+/)
    expect(r.stdout).toContain('payload withheld')
    expect(r.stdout).toContain('--payload')
    expect(r.stdout, 'the losing payload must not reach the model').not.toContain('payload:\n')
  })

  it('inlines the payload for a genuinely high-compressibility input', () => {
    const file = path.join(home, 'high.txt')
    fs.writeFileSync(file, highCompressibilityText())
    const r = runIsolated(['compress-text', '--file', file])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/tokens_saved: \d+/)
    expect(r.stdout, 'a winning compression must still inline its payload').toContain('payload:\n')
    expect(r.stdout).not.toContain('payload withheld')
  })

  it('--payload forces the payload on a losing input', () => {
    const file = path.join(home, 'low.txt')
    fs.writeFileSync(file, lowCompressibilityText())
    const r = runIsolated(['compress-text', '--file', file, '--payload'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/tokens_saved: -\d+/)
    expect(r.stdout, '--payload must preserve the self-contained-blob use case').toContain('payload:\n')
    expect(r.stdout).not.toContain('payload withheld')
  })
})

describe('bytes-per-token ratio constants', () => {
  it('keeps TEXT_BYTES_PER_TOKEN inside the measured range for source text', () => {
    expect(TEXT_BYTES_PER_TOKEN, 'TEXT_BYTES_PER_TOKEN is outside the tiktoken-measured 3.8-4.3 range for source text').toBeGreaterThanOrEqual(3.8)
    expect(TEXT_BYTES_PER_TOKEN, 'TEXT_BYTES_PER_TOKEN is outside the tiktoken-measured 3.8-4.3 range for source text').toBeLessThanOrEqual(4.3)
  })

  it('keeps BASE64URL_BYTES_PER_TOKEN inside the measured range for base64url payloads', () => {
    expect(BASE64URL_BYTES_PER_TOKEN, 'BASE64URL_BYTES_PER_TOKEN is outside the tiktoken-measured 1.40-1.55 range; setting it near the plain-text ratio resurrects the byte-vs-token accounting bug').toBeGreaterThanOrEqual(1.4)
    expect(BASE64URL_BYTES_PER_TOKEN, 'BASE64URL_BYTES_PER_TOKEN is outside the tiktoken-measured 1.40-1.55 range; setting it near the plain-text ratio resurrects the byte-vs-token accounting bug').toBeLessThanOrEqual(1.55)
  })
})
